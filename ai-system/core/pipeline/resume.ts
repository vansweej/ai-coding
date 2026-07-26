import { $ } from "bun";

import type { Result } from "@ai-coding/pipeline";

/** Resume state: the last completed phase number and whether a resume is needed. */
export interface ResumeState {
  readonly needsResume: boolean;
  readonly lastPhaseNumber: number | undefined;
}

/**
 * Find the last commit with a "Phase: N" trailer.
 *
 * @param workspace - The workspace directory
 * @returns The phase number from the last Phase: N commit, or undefined if not found
 */
async function findLastPhaseNumber(workspace: string): Promise<number | undefined> {
  try {
    // Get the last 50 commits with full message (including trailers)
    const log = await $`git log --format=%B -n 50`.cwd(workspace).text();

    // Split by double newline to separate commits
    const commits = log.split(
      /\n\n(?=feat:|fix:|chore:|refactor:|docs:|style:|test:|perf:|ci:|build:)/,
    );

    for (const commit of commits) {
      // Look for Phase: N trailer (can be at end of message)
      const match = commit.match(/Phase:\s*(\d+)/);
      if (match) {
        return Number.parseInt(match[1], 10);
      }
    }

    return undefined;
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

    // Reset to that commit and clean up
    await $`git reset --hard ${targetCommitHash}`.cwd(workspace).quiet();
    await $`git clean -fd`.cwd(workspace).quiet();

    return { ok: true, value: targetCommitHash };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}
