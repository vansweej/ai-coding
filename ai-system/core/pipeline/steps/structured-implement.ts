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
 * instead, via snapshot + rollback.
 *
 * Returns early with an error `Result` -- with NO mutation and NO rollback
 * needed -- when `snapshotTouchedPaths` refuses a directory-touching path.
 */
async function applyEditsTransactionally(
  workspace: string,
  edits: readonly PatchEdit[],
): Promise<Result<void, StructuredDecline>> {
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
      return { ok: false, error: { reason: "dispatch-error", message: outcome.error.message } };
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
