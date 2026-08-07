import { execSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AIRequestEvent, Result, StructuredDeclineReason } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { orchestratePatch } from "../../orchestrator/orchestrate";
import { patchOpsToEdits } from "../../orchestrator/patch-contract";
import { applyPatch } from "./apply-patch-step";
import type { PatchEdit } from "./parse-patch";

/** A typed reason (plus human-readable message) for a declined structured phase. */
export interface StructuredDecline {
  readonly reason: StructuredDeclineReason;
  readonly message: string;
  /**
   * Optional human-readable diagnostic detail, present only for the
   * `dispatch-error` reason. Derived from the underlying error's `cause` so
   * downstream consumers (e.g. the `--verbose` progress feed) can surface the
   * root transport failure without re-appending it to `message` (which already
   * embeds `(cause: X)`).
   */
  readonly detail?: string;
}

/**
 * Snapshot of a single touched path's pre-apply state, used to roll back a
 * partially-applied structured patch (see `applyEditsTransactionally`).
 */
interface PathSnapshot {
  readonly path: string;
  readonly existed: boolean;
  readonly content: string | undefined;
}

/**
 * Collect every filesystem path a set of edits will touch -- `filePath` for
 * all edits, plus `toPath` for move edits -- and snapshot each one's
 * pre-apply state (existence + content) so a partial-apply failure can be
 * rolled back cleanly.
 *
 * Returns an error `Result` -- refusing BEFORE any mutation occurs -- when a
 * touched path is an existing DIRECTORY. A move op may legitimately target a
 * directory (the applier's `renameSync` supports directories), but this
 * transactional snapshot/rollback design cannot faithfully represent or
 * restore a directory (rollback rewrites content via `writeFileSync`, which
 * assumes a file); attempting to `readFileSync` a directory would otherwise
 * throw `EISDIR`. Declining here lets the caller fall back cleanly to the
 * incremental aider-text loop instead of crashing.
 *
 * This is now a DEFENSIVE BACKSTOP only: `applyEditsTransactionally` routes
 * directory-touching edits to the git-transactional path (via
 * `touchesDirectory`) before this function is ever called, so in practice a
 * directory path should never reach here. The guard remains so a future
 * caller cannot reintroduce the `EISDIR` crash.
 */
function snapshotTouchedPaths(
  workspace: string,
  edits: readonly PatchEdit[],
): Result<PathSnapshot[]> {
  const paths = new Set<string>();
  for (const edit of edits) {
    paths.add(edit.filePath);
    if (edit.toPath !== undefined) {
      paths.add(edit.toPath);
    }
  }

  const snapshots: PathSnapshot[] = [];
  for (const relPath of paths) {
    const absPath = resolve(workspace, relPath);
    const existed = existsSync(absPath);
    if (existed && lstatSync(absPath).isDirectory()) {
      return {
        ok: false,
        error: new Error(
          `Refusing structured patch: touched path "${relPath}" is a directory, which cannot be transactionally snapshotted/rolled back`,
        ),
      };
    }
    snapshots.push({
      path: absPath,
      existed,
      content: existed ? readFileSync(absPath, "utf8") : undefined,
    });
  }
  return { ok: true, value: snapshots };
}

/**
 * Cheap, never-throwing probe for whether `workspace` is inside a git work
 * tree. Gates whether directory-touching structured edits may use the
 * git-transactional apply path (see `applyEditsTransactionally`); a `false`
 * result routes directory-touching edits to a graceful `directory-declined`
 * instead, so this must never throw regardless of git's availability.
 */
function isGitRepo(workspace: string): boolean {
  try {
    const stdout = execSync("git rev-parse --is-inside-work-tree", {
      cwd: workspace,
      encoding: "utf8",
      stdio: "pipe",
    });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Restore `workspace` to its clean, committed HEAD state via `git reset
 * --hard HEAD` followed by `git clean -fd`. This deliberately duplicates
 * `phase-runner.ts`'s `restoreWorkingTree` rather than importing it, because
 * importing from `phase-runner.ts` would create an import cycle
 * (`phase-runner` -> `verified-implement-step` -> `structured-implement` ->
 * `phase-runner`). `git clean -fd` omits `-x`, so `.gitignore`d build
 * artifacts survive. This is only ever called after an `applyPatch` failure
 * on a tree that is provably equal to a clean committed HEAD (see the
 * phase-boundary invariant documented on `applyEditsTransactionally`), so
 * `git reset --hard HEAD` cannot destroy earlier uncommitted work -- there
 * is none. Best-effort: the empty catch mirrors `restoreWorkingTree`'s
 * never-throws contract, preserving the original apply error as the primary
 * failure even if the restore itself fails.
 */
function gitRestoreWorkingTree(workspace: string): void {
  try {
    execSync("git reset --hard HEAD", { cwd: workspace, encoding: "utf8" });
    execSync("git clean -fd", { cwd: workspace, encoding: "utf8" });
  } catch {
    // Best-effort restore; the original applyPatch error is still returned
    // to the caller, which falls back to the text loop.
  }
}

/**
 * Returns `true` iff any path touched by `edits` (`filePath`, plus `toPath`
 * for move edits) resolves to an EXISTING directory. Deliberately keys off
 * existing-directory endpoints and NOT off `edit.isMove`/move-kind: a plain
 * FILE move must keep using the in-process content snapshot path below and
 * must keep working in non-git workspaces (see the "rolls back a partial
 * move when a later op fails" test, which moves a plain file in a non-git
 * temp workspace and must remain green). Directory-touching edits are routed
 * to the git-transactional path instead, since the file-content
 * snapshot/rollback model cannot represent or restore a directory.
 */
function touchesDirectory(workspace: string, edits: readonly PatchEdit[]): boolean {
  const paths = new Set<string>();
  for (const edit of edits) {
    paths.add(edit.filePath);
    if (edit.toPath !== undefined) {
      paths.add(edit.toPath);
    }
  }
  for (const relPath of paths) {
    const absPath = resolve(workspace, relPath);
    if (existsSync(absPath) && lstatSync(absPath).isDirectory()) {
      return true;
    }
  }
  return false;
}

/**
 * Restore every snapshotted path to its pre-apply state: paths that existed
 * before are rewritten with their original content (undoing an edit, or
 * un-doing a move's destination-side effect on the source path); paths that
 * did NOT exist before but now do (a create, or a move's destination) are
 * removed. Best-effort -- this runs only after `applyPatch` has already
 * failed, so a rollback I/O error is logged to the returned list rather than
 * thrown, preserving the original apply error as the primary failure.
 */
function rollbackToSnapshot(snapshots: readonly PathSnapshot[]): void {
  for (const snapshot of snapshots) {
    try {
      if (snapshot.existed) {
        writeFileSync(snapshot.path, snapshot.content ?? "", "utf8");
      } else if (existsSync(snapshot.path)) {
        rmSync(snapshot.path, { force: true });
      }
    } catch {
      // Best-effort rollback; the original applyPatch error is still
      // returned to the caller, which falls back to the text loop.
    }
  }
}

/**
 * Apply structured edits to the workspace ALL-OR-NOTHING. `applyPatch`
 * applies edits sequentially and stops at the first failure, which can
 * leave earlier edits already written to disk -- unlike the incremental
 * aider-text loop (which is designed to tolerate and resume from partial
 * progress), the whole-phase structured attempt must never leave a
 * half-applied tree behind, since a caller that falls back to the text loop
 * assumes it is starting from a clean, fully-attributable state.
 *
 * Does NOT rely on the applier's idempotent no-op semantics (byte-identical
 * create / already-satisfied move) -- those exist to make the TEXT loop's
 * re-issued edits safe to retry; this whole-phase attempt is transactional
 * instead.
 *
 * Branches on `touchesDirectory(workspace, edits)`:
 *
 * - DIRECTORY-TOUCHING edits (any touched path resolves to an existing
 *   directory): applied via a GIT-TRANSACTIONAL path. If `workspace` is not
 *   a git repository, declines gracefully with `directory-declined` (no
 *   mutation) -- directory moves cannot be safely rolled back without git.
 *   Otherwise applies via `applyPatch` (whose `renameSync`-based move verb
 *   natively supports directories) and, on failure, restores the tree via
 *   `gitRestoreWorkingTree` (`git reset --hard HEAD` + `git clean -fd`)
 *   before returning an `apply-failed` error. This is SAFE because
 *   `tryStructuredPhase` is invoked exactly once per phase, at the top of
 *   `createVerifiedImplementStep.execute` (`verified-implement-step.ts:546`),
 *   BEFORE any step edits are applied and before the text loop runs; and
 *   `runPhase` commits at each phase boundary. So at structured-apply time
 *   the working tree is provably equal to a clean committed HEAD, and
 *   `git reset --hard HEAD` cannot destroy earlier-step uncommitted work --
 *   there is none.
 * - FILE-ONLY edits (no touched path is an existing directory): applied via
 *   the original in-process content snapshot + rollback (`snapshotTouchedPaths`
 *   / `rollbackToSnapshot`), which works without a git repository and covers
 *   plain file creates/edits/moves.
 */
async function applyEditsTransactionally(
  workspace: string,
  edits: readonly PatchEdit[],
): Promise<Result<void, StructuredDecline>> {
  if (touchesDirectory(workspace, edits)) {
    if (!isGitRepo(workspace)) {
      return {
        ok: false,
        error: {
          reason: "directory-declined",
          message:
            "Refusing structured patch: directory-touching edits require a git workspace for transactional rollback; declining to the aider-text fallback",
        },
      };
    }

    const applyResult = await applyPatch(workspace, edits);
    if (!applyResult.ok) {
      gitRestoreWorkingTree(workspace);
      return {
        ok: false,
        error: {
          reason: "apply-failed",
          message: `Failed to apply structured patch to "${applyResult.error.filePath}": ${applyResult.error.message}`,
        },
      };
    }
    return { ok: true, value: undefined };
  }

  const snapshotResult = snapshotTouchedPaths(workspace, edits);
  if (!snapshotResult.ok) {
    return {
      ok: false,
      error: { reason: "directory-declined", message: snapshotResult.error.message },
    };
  }
  const snapshots = snapshotResult.value;

  const applyResult = await applyPatch(workspace, edits);
  if (!applyResult.ok) {
    rollbackToSnapshot(snapshots);
    return {
      ok: false,
      error: {
        reason: "apply-failed",
        message: `Failed to apply structured patch to "${applyResult.error.filePath}": ${applyResult.error.message}`,
      },
    };
  }

  return { ok: true, value: undefined };
}

/**
 * Attempt the WHOLE-PHASE structured patch path: ask the resolved model for
 * one forced structured-op response covering the entire phase at once (via
 * `orchestratePatch`), convert it to `PatchEdit[]`, and apply it
 * transactionally.
 *
 * This function NEVER THROWS. Returns an error `Result` for every
 * non-success case: the model/attempt is not structured-capable
 * (`orchestratePatch` returned `{ kind: "not-capable" }`), the dispatch
 * itself failed, the ops failed `patchOpsToEdits` conversion, or the
 * transactional apply failed (in which case the workspace has already been
 * rolled back to its pre-attempt state). Every decline is attributed via a
 * typed `StructuredDecline` (`reason` + `message`) rather than a bare
 * `Error`, so callers can distinguish WHY the structured path declined. In
 * every error case the caller is expected to fall back to the existing
 * incremental aider-text loop for this attempt -- this function never
 * mutates pipeline/retry state itself.
 *
 * Never touches `config.dispatchers` directly -- all model resolution and
 * capability feature-detection happens inside `orchestratePatch`, so this
 * helper stays behind the same facade the text path already depends on.
 *
 * The entire body runs inside a single try/catch: any thrown error --
 * including a rejected `dispatchPatch` propagating up through
 * `orchestratePatch` (which does not itself guard against a rejecting
 * dispatcher) -- is converted into an error `Result`, so this function
 * structurally never throws and the caller's fallback-to-text-loop contract
 * always holds.
 */
export async function tryStructuredPhase(
  event: AIRequestEvent,
  config: OrchestratorConfig,
  workspace: string,
): Promise<Result<"applied", StructuredDecline>> {
  try {
    const outcome = await orchestratePatch(event, config);
    if (!outcome.ok) {
      const cause = outcome.error.cause;
      const detail =
        cause instanceof Error
          ? cause.message
          : cause !== undefined
            ? String(cause)
            : outcome.error.message;
      return {
        ok: false,
        error: { reason: "dispatch-error", message: outcome.error.message, detail },
      };
    }

    if (outcome.value.kind === "not-capable") {
      const reason =
        outcome.value.reason === "text-mode"
          ? "not-capable-text-mode"
          : "not-capable-no-dispatch-patch";
      return {
        ok: false,
        error: { reason, message: "Model/attempt is not structured-patch capable" },
      };
    }

    const editsResult = patchOpsToEdits(outcome.value.ops);
    if (!editsResult.ok) {
      return {
        ok: false,
        error: { reason: "conversion-failed", message: editsResult.error.message },
      };
    }

    const applyResult = await applyEditsTransactionally(workspace, editsResult.value);
    if (!applyResult.ok) {
      return applyResult;
    }

    return { ok: true, value: "applied" };
  } catch (error) {
    return {
      ok: false,
      error: { reason: "threw", message: error instanceof Error ? error.message : String(error) },
    };
  }
}
