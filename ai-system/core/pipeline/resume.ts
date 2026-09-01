import { $ } from "bun";

import type { Result } from "@ai-coding/pipeline";

import { buildGitCleanArgs } from "./git-clean-args";

/** Resume state: the last completed phase number and whether a resume is needed. */
export interface ResumeState {
  readonly needsResume: boolean;
  readonly lastPhaseNumber: number | undefined;
}

/**
 * Trunk ref candidates tried, in order, to bound the Phase-trailer search to
 * commits made since the current branch diverged from its trunk.
 */
const TRUNK_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

/**
 * Resolve a lower-bound commit for the Phase-trailer search: the merge-base
 * between HEAD and the first trunk candidate that (a) exists and (b) is not
 * simply the branch we're already on.
 *
 * Returns undefined when no distinct trunk can be identified -- e.g. a
 * standalone repo with no separate feature branch, or plan-cycle running
 * directly on the trunk branch itself (main/master) rather than via a
 * choragos-style `feat/<slug>` branch. In that case the caller falls back to
 * the previous unscoped search, since there is no fork point to bound
 * against and any Phase trailer found is legitimately part of the current
 * workspace's own history.
 */
async function resolveTrunkMergeBase(workspace: string): Promise<string | undefined> {
  let currentBranch: string;
  try {
    currentBranch = (await $`git rev-parse --abbrev-ref HEAD`.cwd(workspace).quiet().text()).trim();
  } catch {
    return undefined;
  }

  for (const trunk of TRUNK_CANDIDATES) {
    const trunkShortName = trunk.replace(/^origin\//, "");
    if (trunkShortName === currentBranch) continue; // already on the trunk itself

    try {
      const mergeBase = (
        await $`git merge-base HEAD ${trunk}`.cwd(workspace).quiet().text()
      ).trim();
      if (mergeBase) return mergeBase;
    } catch {
      // Candidate ref doesn't exist locally (no such branch/remote) -- try the next one.
    }
  }

  return undefined;
}

/**
 * Result of {@link classifyResumeScan}: the last completed phase number (if
 * any) and, when that reset-target commit LACKS a `Run-Id:` trailer, the
 * commit subject line to surface as a diagnostic hint.
 */
export interface ResumeTargetScan {
  readonly lastPhaseNumber: number | undefined;
  readonly targetSubject: string | undefined;
}

/**
 * Classify the resume target commit (the commit carrying the highest
 * `Phase: N` trailer, i.e. the one `resetToPhaseCommit` would reset to).
 *
 * Delegates entirely to {@link findLastPhaseNumber} for `lastPhaseNumber` --
 * never duplicates its regex or git-log logic. When a last phase number is
 * found, re-runs the SAME bounded `git log` query and the SAME commit-split
 * regex to locate that specific commit's block, then inspects ONLY that
 * block (the deliberate narrow trigger: this is not a general commit-history
 * scan) for a `Run-Id:` trailer. When the trailer is ABSENT, `targetSubject`
 * is set to that commit's first non-empty line (its subject); otherwise
 * `targetSubject` is `undefined`.
 *
 * Never throws: any git failure degrades to "no signal"
 * (`{ lastPhaseNumber, targetSubject: undefined }`), mirroring
 * `findLastPhaseNumber`'s Result-free plain-async convention.
 *
 * @param workspace - The workspace directory
 */
export async function classifyResumeScan(workspace: string): Promise<ResumeTargetScan> {
  const lastPhaseNumber = await findLastPhaseNumber(workspace);
  if (lastPhaseNumber === undefined) {
    return { lastPhaseNumber: undefined, targetSubject: undefined };
  }

  try {
    const mergeBase = await resolveTrunkMergeBase(workspace);
    const log = mergeBase
      ? await $`git log --format=%B -n 50 ${mergeBase}..HEAD`.cwd(workspace).text()
      : await $`git log --format=%B -n 50`.cwd(workspace).text();

    const commits = log.split(
      /\n\n(?=feat:|fix:|chore:|refactor:|docs:|style:|test:|perf:|ci:|build:)/,
    );

    for (const commit of commits) {
      const match = commit.match(/Phase:\s*(\d+)/);
      if (!match) continue;
      const phaseNumber = Number.parseInt(match[1], 10);
      if (phaseNumber !== lastPhaseNumber) continue;

      const hasRunId = /Run-Id:\s*\S+/.test(commit);
      if (hasRunId) {
        return { lastPhaseNumber, targetSubject: undefined };
      }

      const firstNonEmptyLine = commit
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);

      return { lastPhaseNumber, targetSubject: firstNonEmptyLine };
    }

    return { lastPhaseNumber, targetSubject: undefined };
  } catch {
    return { lastPhaseNumber, targetSubject: undefined };
  }
}

/**
 * Find the last commit with a "Phase: N" trailer.
 *
 * The search is bounded to commits made since the current branch diverged
 * from its trunk (see `resolveTrunkMergeBase`), when such a trunk can be
 * identified. Without this bound, a freshly created feature branch's `git
 * log -n 50` from HEAD walks straight through the trunk's own history --
 * including any already-merged, unrelated feature's `Phase: N` commits --
 * and can incorrectly report a stale resume target from a completely
 * different feature. This was observed in production: a brand-new
 * `feat/<slug>` branch, freshly forked from `main` with zero commits of its
 * own, matched an old merged feature's `Phase: 7` commit within the last 50
 * commits of `main`'s history and was reset all the way back to that
 * ancestor commit -- landing behind `base_sha` and failing choragos's "HEAD
 * must descend from base_sha" invariant, even though the new branch had
 * done nothing wrong.
 *
 * When no trunk can be identified (e.g. a standalone repo, or plan-cycle
 * running directly on the trunk branch itself with no separate feature
 * branch), falls back to the previous unscoped `-n 50` search from HEAD --
 * there is no fork point to bound against, matching historical behavior for
 * that case.
 *
 * @param workspace - The workspace directory
 * @returns The phase number from the last Phase: N commit, or undefined if not found
 */
async function findLastPhaseNumber(workspace: string): Promise<number | undefined> {
  try {
    const mergeBase = await resolveTrunkMergeBase(workspace);
    const log = mergeBase
      ? await $`git log --format=%B -n 50 ${mergeBase}..HEAD`.cwd(workspace).text()
      : await $`git log --format=%B -n 50`.cwd(workspace).text();

    // Split by double newline to separate commits
    const commits = log.split(
      /\n\n(?=feat:|fix:|chore:|refactor:|docs:|style:|test:|perf:|ci:|build:)/,
    );

    let highest: number | undefined;
    for (const commit of commits) {
      // Look for Phase: N trailer (can be at end of message)
      const match = commit.match(/Phase:\s*(\d+)/);
      if (match) {
        const phaseNumber = Number.parseInt(match[1], 10);
        if (highest === undefined || phaseNumber > highest) {
          highest = phaseNumber;
        }
      }
    }

    return highest;
  } catch {
    return undefined;
  }
}

/**
 * Determine if a resume is needed by checking for a "Phase: N" commit trailer
 * in recent history.
 *
 * A resume is needed whenever a `Phase: N` trailer is found, regardless of
 * whether the working tree is currently dirty or clean. A clean tree does NOT
 * mean "nothing to resume" -- a phase can fail mid-implementation and roll
 * back cleanly (patch application failures are never partially written), which
 * is indistinguishable from "no run has started yet" if resume only looks at
 * dirtiness. Gating resume on dirty state caused a completed-but-not-finished
 * feature (e.g. phases 1-6 committed, phase 7 failed and rolled back to a
 * clean tree) to be silently restarted from phase 1 on the next run --
 * re-applying already-committed phases and colliding with their now-stale
 * SEARCH anchors. `resetToPhaseCommit` is safe to call even when the tree
 * already matches the target commit (reset + clean are no-ops in that case).
 *
 * @param workspace - The workspace directory
 * @returns ResumeState with needsResume flag and last phase number
 */
export async function detectResumeState(workspace: string): Promise<ResumeState> {
  const lastPhaseNumber = await findLastPhaseNumber(workspace);
  if (lastPhaseNumber === undefined) {
    return { needsResume: false, lastPhaseNumber: undefined };
  }

  return { needsResume: true, lastPhaseNumber };
}

/**
 * Reset the workspace to the last Phase: N commit and clean up.
 *
 * @param workspace - The workspace directory
 * @param phaseNumber - The phase number to reset to
 * @returns Result with the reset commit hash, or error
 */
export async function resetToPhaseCommit(
  workspace: string,
  phaseNumber: number,
): Promise<Result<string>> {
  try {
    // Find the commit with Phase: N trailer using git log
    const log = await $`git log --format=%H%n%B%n---COMMIT_SEPARATOR---`.cwd(workspace).text();
    const commitBlocks = log.split("---COMMIT_SEPARATOR---").filter((b) => b.trim());

    let targetCommitHash: string | undefined;
    for (const block of commitBlocks) {
      const lines = block.trim().split("\n");
      if (lines.length < 2) continue;

      const hash = lines[0];
      const message = lines.slice(1).join("\n");

      // Check if this commit has the Phase: N trailer (handles whitespace variations)
      const phaseRegex = new RegExp(`Phase:\\s+${phaseNumber}(?:\\s|$)`);
      if (phaseRegex.test(message)) {
        targetCommitHash = hash;
        break;
      }
    }

    if (!targetCommitHash) {
      return {
        ok: false,
        error: new Error(`No commit found with Phase: ${phaseNumber} trailer`),
      };
    }

    // Reset to that commit and clean up. `resetToPhaseCommit` does not
    // receive a `--plan` path, so `buildGitCleanArgs` applies the blanket
    // `plans/` exclusion only (see git-clean-args.ts).
    await $`git reset --hard ${targetCommitHash}`.cwd(workspace).quiet();
    const cleanArgs = buildGitCleanArgs(workspace);
    await $`git ${cleanArgs}`.cwd(workspace).quiet();

    return { ok: true, value: targetCommitHash };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
