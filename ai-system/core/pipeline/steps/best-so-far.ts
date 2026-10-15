import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGitCleanArgs } from "../git-clean-args";
import type { SnapshotOutcome } from "../snapshot";
import { captureSnapshot, writeWorkingTreeObject } from "../snapshot";
import type { ProgressScore } from "./progress-score";
import { compareProgress } from "./progress-score";

/** The best non-regressed failed attempt captured in a retry loop. */
export interface BestSoFar {
  readonly tree: string;
  readonly score: ProgressScore;
  readonly attempt: number;
  readonly band: "local" | "escalation";
  readonly error: Error;
}

/**
 * Capture the current working tree as a candidate best attempt. Capture
 * failures, including non-git workspaces, leave the previous best unchanged.
 */
export function recordAttempt(
  workspace: string,
  score: ProgressScore,
  error: Error,
  attempt: number,
  band: "local" | "escalation",
  previous: BestSoFar | undefined,
): BestSoFar | undefined {
  const tree = writeWorkingTreeObject(workspace);
  if (!tree.ok) return previous;
  const candidate: BestSoFar = { tree: tree.value, score, attempt, band, error };
  if (previous === undefined) return candidate;
  return compareProgress(previous.score, score) === "worse" ? previous : candidate;
}

/**
 * Restore the best captured tree only when the current attempt has regressed
 * to an earlier verification gate. This leaves the real index at HEAD.
 */
export function revertToBest(params: {
  readonly workspace: string;
  readonly runId?: string;
  readonly phase: number;
  readonly planPath?: string;
  readonly attempt: number;
  readonly band: "local" | "escalation";
  readonly best: BestSoFar;
  readonly current: ProgressScore;
}): { reverted: boolean; snapshot?: SnapshotOutcome } {
  if (compareProgress(params.best.score, params.current) !== "worse") {
    return { reverted: false };
  }
  let snapshot: SnapshotOutcome | undefined;
  if (params.runId !== undefined) {
    snapshot = captureSnapshot({
      workspace: params.workspace,
      runId: params.runId,
      phase: params.phase,
      label: `worse-${params.band}-${params.attempt}`,
    });
  }
  try {
    execFileSync("git", ["reset", "--hard", "HEAD"], {
      cwd: params.workspace,
      encoding: "utf8",
    });
    execFileSync("git", buildGitCleanArgs(params.workspace, params.planPath), {
      cwd: params.workspace,
      encoding: "utf8",
    });
    const tempDir = mkdtempSync(join(tmpdir(), "ai-coding-bsf-"));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(tempDir, "index") };
      execFileSync("git", ["read-tree", params.best.tree], {
        cwd: params.workspace,
        env,
        encoding: "utf8",
      });
      execFileSync("git", ["checkout-index", "-a", "-f"], {
        cwd: params.workspace,
        env,
        encoding: "utf8",
      });
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup must not mask the restore result.
      }
    }
    return { reverted: true, snapshot };
  } catch {
    return { reverted: false, snapshot };
  }
}
