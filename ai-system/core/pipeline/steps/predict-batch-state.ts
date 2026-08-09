import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import type { PatchEdit } from "./parse-patch";

/**
 * Shared in-order predicted-state fold consumed by BOTH
 * `coerceCreatesToEdits` and `expandTableHeaderAnchors`.
 *
 * This module is the single source of truth for how a whole-phase batch of
 * `PatchEdit`s predicts each touched path's post-op content as the batch
 * walks in order. Both normalization passes need the same answer to "what
 * will this file's content be at this point in the batch, given the ops
 * that ran before it" — before this module existed, each pass carried its
 * own copy-pasted `resolveInWorkspace` and its own local prediction map,
 * which could (and did) drift out of sync.
 *
 * The four `record` rules, verbatim (single source of truth):
 *   1. `edit.isMove`: let `sourceAbs = resolveInWorkspace(workspace, edit.filePath)`;
 *      let `destAbs = edit.toPath !== undefined ? resolveInWorkspace(workspace, edit.toPath) : undefined`.
 *      Only when BOTH are defined: `predicted.set(destAbs, predictedContentOf(sourceAbs))`
 *      then `predicted.set(sourceAbs, null)`. (Order matters: read source
 *      before nulling it.)
 *   2. `edit.isCreate === true`: let `abs = resolveInWorkspace(workspace, edit.filePath)`;
 *      if defined, `predicted.set(abs, edit.replace)`.
 *   3. `edit.wholeFileReplace === true`: let `abs = resolveInWorkspace(workspace, edit.filePath)`;
 *      if defined, `predicted.set(abs, edit.replace)`.
 *   4. Otherwise (a plain partial edit): NO update — a partial edit's
 *      post-edit content is deliberately not simulated.
 */

/**
 * Resolve `filePath` against `workspace`, returning the normalized absolute
 * path if it resolves INSIDE the workspace, or `undefined` if it is
 * absolute or escapes the workspace root.
 *
 * CONTRACT NOTE (spar Risk 2): an out-of-workspace or absolute path
 * resolves to `undefined` and must NEVER become a key in the
 * predicted-state map; consumers treat an unresolvable path as
 * predicted-`null` (pass-through), and this `undefined` check must fire
 * before any predicted lookup.
 */
export function resolveInWorkspace(workspace: string, filePath: string): string | undefined {
  if (isAbsolute(filePath)) return undefined;
  const resolved = normalize(join(workspace, filePath));
  const normalizedRoot = normalize(workspace);
  const isInsideWorkspace =
    resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}/`);
  return isInsideWorkspace ? resolved : undefined;
}

/**
 * A batch-aware predicted-state fold over a single workspace, holding a
 * `Map<absPath, string | null>` of each touched path's predicted content
 * (`null` meaning predicted absent/deleted).
 */
export interface BatchStatePredictor {
  readonly predictedContentOf: (absPath: string) => string | null;
  readonly record: (edit: PatchEdit) => void;
}

/**
 * Create a fresh `BatchStatePredictor` for `workspace`. All state lives in
 * the returned closure; the factory itself holds no global state.
 */
export function createBatchStatePredictor(workspace: string): BatchStatePredictor {
  const predicted = new Map<string, string | null>();

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

  const record = (edit: PatchEdit): void => {
    if (edit.isMove) {
      const sourceAbs = resolveInWorkspace(workspace, edit.filePath);
      const destAbs =
        edit.toPath !== undefined ? resolveInWorkspace(workspace, edit.toPath) : undefined;
      if (sourceAbs !== undefined && destAbs !== undefined) {
        predicted.set(destAbs, predictedContentOf(sourceAbs));
        predicted.set(sourceAbs, null);
      }
      return;
    }

    if (edit.isCreate === true) {
      const abs = resolveInWorkspace(workspace, edit.filePath);
      if (abs !== undefined) {
        predicted.set(abs, edit.replace);
      }
      return;
    }

    if (edit.wholeFileReplace === true) {
      const abs = resolveInWorkspace(workspace, edit.filePath);
      if (abs !== undefined) {
        predicted.set(abs, edit.replace);
      }
      return;
    }

    // Plain partial edit: post-edit content is deliberately not simulated.
  };

  return { predictedContentOf, record };
}

/**
 * Consume `edits` in order, yielding each edit alongside the predicted
 * content of its `filePath` BEFORE this edit applies, then advancing the
 * fold by recording this edit AFTER the yield resumes. This guarantees the
 * consumer always sees pre-edit state and the fold advances by the same
 * single source-of-truth rules as `BatchStatePredictor.record`.
 */
export function* predictBatchStates(
  workspace: string,
  edits: readonly PatchEdit[],
): Generator<{ readonly edit: PatchEdit; readonly predictedContentForFilePath: string | null }> {
  const predictor = createBatchStatePredictor(workspace);

  for (const edit of edits) {
    const resolved = resolveInWorkspace(workspace, edit.filePath);
    const predictedContentForFilePath =
      resolved === undefined ? null : predictor.predictedContentOf(resolved);
    yield { edit, predictedContentForFilePath };
    predictor.record(edit);
  }
}
