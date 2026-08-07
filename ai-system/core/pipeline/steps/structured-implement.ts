import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AIRequestEvent, Result } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { orchestratePatch } from "../../orchestrator/orchestrate";
import { patchOpsToEdits } from "../../orchestrator/patch-contract";
import { applyPatch } from "./apply-patch-step";
import type { PatchEdit } from "./parse-patch";

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
 */
function snapshotTouchedPaths(workspace: string, edits: readonly PatchEdit[]): PathSnapshot[] {
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
    snapshots.push({
      path: absPath,
      existed,
      content: existed ? readFileSync(absPath, "utf8") : undefined,
    });
  }
  return snapshots;
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
 */
async function applyEditsTransactionally(
  workspace: string,
  edits: readonly PatchEdit[],
): Promise<Result<void>> {
  const snapshots = snapshotTouchedPaths(workspace, edits);

  const applyResult = await applyPatch(workspace, edits);
  if (!applyResult.ok) {
    rollbackToSnapshot(snapshots);
    return {
      ok: false,
      error: new Error(
        `Failed to apply structured patch to "${applyResult.error.filePath}": ${applyResult.error.message}`,
      ),
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
 * Returns an error Result -- never throws -- for every non-success case:
 * the model/attempt is not structured-capable (`orchestratePatch` returned
 * `{ kind: "not-capable" }`), the dispatch itself failed, the ops failed
 * `patchOpsToEdits` conversion, or the transactional apply failed (in which
 * case the workspace has already been rolled back to its pre-attempt
 * state). In EVERY error case the caller is expected to fall back to the
 * existing incremental aider-text loop for this attempt -- this function
 * never mutates pipeline/retry state itself.
 *
 * Never touches `config.dispatchers` directly -- all model resolution and
 * capability feature-detection happens inside `orchestratePatch`, so this
 * helper stays behind the same facade the text path already depends on.
 */
export async function tryStructuredPhase(
  event: AIRequestEvent,
  config: OrchestratorConfig,
  workspace: string,
): Promise<Result<"applied">> {
  const outcome = await orchestratePatch(event, config);
  if (!outcome.ok) {
    return outcome;
  }

  if (outcome.value.kind === "not-capable") {
    return { ok: false, error: new Error("Model/attempt is not structured-patch capable") };
  }

  const editsResult = patchOpsToEdits(outcome.value.ops);
  if (!editsResult.ok) {
    return { ok: false, error: new Error(editsResult.error.message) };
  }

  const applyResult = await applyEditsTransactionally(workspace, editsResult.value);
  if (!applyResult.ok) {
    return applyResult;
  }

  return { ok: true, value: "applied" };
}
