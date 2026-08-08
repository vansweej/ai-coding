import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import type { PatchEdit } from "./parse-patch";

/**
 * Filesystem-aware, batch-aware normalization pass for structured patch
 * edits.
 *
 * `patchOpsToEdits` (patch-contract.ts) is deliberately filesystem-blind: it
 * converts raw model `PatchOp`s into `PatchEdit`s without ever touching disk.
 * That is by design, but it means the model is free to emit a `create` op for
 * a file that already exists on disk (e.g. relocated there by an earlier
 * `move` op in the same phase) — which the applier then rejects with
 * `"already exists; cannot create"`, forcing an unnecessary fallback to the
 * aider-text repair loop.
 *
 * `coerceCreatesToEdits` is the sole filesystem-aware seam between that
 * blind conversion and the transactional apply step. Because the whole-phase
 * batch is applied transactionally IN ORDER, this function walks `edits` in
 * order and maintains a `Map<absPath, string | null>` of each touched path's
 * PREDICTED content (`null` meaning predicted absent/deleted), so a `create`
 * whose target is produced by a preceding in-batch `move`/`create` is
 * evaluated against the state the batch will actually produce, not just
 * current disk state (finding `151af9e0`). A path with no prediction entry
 * has its state resolved lazily from disk on demand, and once an op has
 * written a prediction for a path, that prediction is always trusted from
 * then on — disk is never re-read for a path mid-fold, since re-reading
 * would reintroduce the independent-per-edit bug this closes.
 *
 * For each edit, in order:
 *   - A plain edit (not create, not move) passes through unchanged. Its
 *     post-edit content is NOT simulated — a plain edit targeting a
 *     create-target is a pathological, out-of-scope case; any existing
 *     prediction for its path is left as-is.
 *   - A move passes through unchanged. Predictions are updated to reflect
 *     the rename: the destination's predicted content becomes the source's
 *     predicted content, and the source's predicted content becomes `null`.
 *     Only in-workspace, non-absolute endpoints are simulated; absolute or
 *     out-of-workspace endpoints are left to the applier's path guard.
 *   - A create whose target path resolves OUTSIDE the workspace (or is
 *     absolute) passes through unchanged without reading the filesystem or
 *     touching the prediction map — path safety remains the sole
 *     responsibility of `assertInsideWorkspace`, which runs later inside
 *     `applyPatch` and will reject it there.
 *   - A create whose predicted target content is absent (`null`) passes
 *     through unchanged (a genuinely new file); the prediction is then set
 *     to the create's contents.
 *   - A create whose predicted target content is EMPTY (`""`, whether empty
 *     on disk or produced empty by a prior op) passes through unchanged as a
 *     create — the applier's empty-file relaxation (apply-patch-step.ts)
 *     overwrites it deterministically, since the target only exists on disk
 *     (as empty) at apply time; the prediction is then set to the create's
 *     contents.
 *   - A create whose predicted target content is byte-identical to the
 *     create's contents passes through unchanged (the applier already
 *     treats this as a no-op success); the prediction is unchanged.
 *   - A create whose predicted target content is non-empty and DIFFERS from
 *     the create's contents is COERCED into a whole-file-replace edit:
 *     `isCreate: false`, `search` = the predicted current contents,
 *     `replace` = the create's contents. Because a string cannot contain
 *     two non-overlapping copies of its own entirety, this `search` is
 *     guaranteed to match exactly once, so the applier's edit branch
 *     applies it cleanly instead of declining. The prediction is then set
 *     to the create's contents.
 *
 * Known limitation (not a regression): a `create` targeting a path UNDER a
 * moved directory is not modeled by this flat content-keyed fold — the fold
 * only tracks exact touched paths, not directory subtrees. Today's
 * independent per-edit map fails this case identically, so this is an
 * existing gap, not something this change introduces; flag for a future
 * plan if it surfaces.
 *
 * This function never throws (filesystem errors are treated defensively as
 * "not coercible, pass through unchanged"), never mutates its input, never
 * performs its own path-safety checks (leaving `assertInsideWorkspace` as
 * the sole gate inside `applyPatch`), and always returns a new array.
 *
 * @param workspace - The workspace root the phase is running against.
 * @param edits - The edits produced by `patchOpsToEdits`.
 * @returns A new array of edits with eligible creates coerced to edits.
 */
export function coerceCreatesToEdits(
  workspace: string,
  edits: readonly PatchEdit[],
): readonly PatchEdit[] {
  const normalizedRoot = normalize(workspace);
  const predicted = new Map<string, string | null>();

  const resolveInWorkspace = (filePath: string): string | undefined => {
    if (isAbsolute(filePath)) return undefined;
    const resolved = normalize(join(workspace, filePath));
    const isInsideWorkspace =
      resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}/`);
    return isInsideWorkspace ? resolved : undefined;
  };

  const predictedContentOf = (absPath: string): string | null => {
    if (predicted.has(absPath)) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by has() above
      return predicted.get(absPath)!;
    }
    try {
      if (!existsSync(absPath)) return null;
      return readFileSync(absPath, "utf8");
    } catch {
      // Defensive: any read failure is treated as "absent/unknown".
      return null;
    }
  };

  const result: PatchEdit[] = [];

  for (const edit of edits) {
    if (edit.isMove) {
      result.push(edit);
      const sourceAbs = resolveInWorkspace(edit.filePath);
      const destAbs = edit.toPath !== undefined ? resolveInWorkspace(edit.toPath) : undefined;
      if (sourceAbs !== undefined && destAbs !== undefined) {
        predicted.set(destAbs, predictedContentOf(sourceAbs));
        predicted.set(sourceAbs, null);
      }
      continue;
    }

    if (!edit.isCreate) {
      result.push(edit);
      continue;
    }

    const resolvedAbs = resolveInWorkspace(edit.filePath);
    if (resolvedAbs === undefined) {
      result.push(edit);
      continue;
    }

    const current = predictedContentOf(resolvedAbs);

    if (current === null) {
      // Predicted absent: a genuinely new file.
      result.push(edit);
      predicted.set(resolvedAbs, edit.replace);
      continue;
    }

    if (current === "") {
      // Predicted empty (on disk or produced empty by a prior op): leave as
      // a create; the applier's empty-file relaxation handles it at apply
      // time since the target only exists (as empty) then.
      result.push(edit);
      predicted.set(resolvedAbs, edit.replace);
      continue;
    }

    if (current === edit.replace) {
      // Byte-identical: the applier already treats this as a no-op success.
      result.push(edit);
      predicted.set(resolvedAbs, edit.replace);
      continue;
    }

    // Predicted non-empty and differing: coerce to a whole-file-replace edit.
    result.push({
      filePath: edit.filePath,
      search: current,
      replace: edit.replace,
      isCreate: false,
      isMove: false,
    });
    predicted.set(resolvedAbs, edit.replace);
  }

  return result;
}
