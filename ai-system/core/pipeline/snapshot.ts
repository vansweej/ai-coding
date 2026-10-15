import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import type { Result } from "@ai-coding/pipeline";

import { resolveLedgerDir } from "../../../src/ledger/ledger-writer";

/**
 * Write a git tree object for the CURRENT working-tree state (including
 * untracked, gitignore-respecting files) WITHOUT touching the real index or
 * working tree. Uses a throwaway index copy under the OS temp dir via
 * GIT_INDEX_FILE. Reused by P4's best-so-far restore. Never throws.
 */
export function writeWorkingTreeObject(workspace: string): Result<string> {
  try {
    const gitPathIndex = execFileSync("git", ["rev-parse", "--git-path", "index"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
    const realIndex = isAbsolute(gitPathIndex) ? gitPathIndex : join(workspace, gitPathIndex);

    const tempDir = mkdtempSync(join(tmpdir(), "ai-coding-snap-"));
    const tempIndex = join(tempDir, "index");
    try {
      try {
        statSync(realIndex);
        copyFileSync(realIndex, tempIndex);
      } catch {
        // No existing index (fresh repo): start from an empty temp index.
      }
      const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
      execFileSync("git", ["add", "-A"], { cwd: workspace, env, encoding: "utf8" });
      const treeSha = execFileSync("git", ["write-tree"], {
        cwd: workspace,
        env,
        encoding: "utf8",
      }).trim();
      return { ok: true, value: treeSha };
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup; never mask the result.
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/** Outcome of a forensic snapshot capture. Never throws; failures are data. */
export type SnapshotOutcome =
  | {
      readonly ok: true;
      readonly treeSha: string;
      readonly dir: string;
      readonly patchBytes: number;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Capture a durable forensic snapshot of the failed working tree BEFORE a
 * destructive reset. Writes a binary diff and a porcelain status under
 * <ledgerDir>/snapshots/<runId>/phase-<N>-<label>/. Never throws.
 */
export function captureSnapshot(opts: {
  workspace: string;
  runId: string;
  phase: number;
  label: string;
}): SnapshotOutcome {
  const tree = writeWorkingTreeObject(opts.workspace);
  if (!tree.ok) return { ok: false, reason: tree.error.message };
  try {
    const dir = join(
      resolveLedgerDir(),
      "snapshots",
      opts.runId,
      `phase-${opts.phase}-${opts.label}`,
    );
    mkdirSync(dir, { recursive: true });
    const patch = execFileSync("git", ["diff", "--binary", "HEAD", tree.value], {
      cwd: opts.workspace,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    writeFileSync(join(dir, "changes.patch"), patch, "utf8");
    const status = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: opts.workspace,
      encoding: "utf8",
    });
    writeFileSync(join(dir, "status.txt"), status, "utf8");
    return { ok: true, treeSha: tree.value, dir, patchBytes: Buffer.byteLength(patch) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
