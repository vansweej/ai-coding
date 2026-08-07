import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";

import type { PatchEdit } from "./parse-patch";

/**
 * Filesystem-aware normalization pass for structured patch edits.
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
 * blind conversion and the transactional apply step. For each edit:
 *   - Non-create edits (plain edits, moves) pass through unchanged.
 *   - A create whose target path resolves OUTSIDE the workspace passes
 *     through unchanged without reading the filesystem — path safety
 *     remains the sole responsibility of `assertInsideWorkspace`, which
 *     runs later inside `applyPatch` and will reject it there.
 *   - A create whose target does not exist on disk passes through
 *     unchanged (a genuinely new file).
 *   - A create whose target exists and is EMPTY (0 bytes) passes through
 *     unchanged as a create — the applier's empty-file relaxation
 *     (apply-patch-step.ts) overwrites it deterministically.
 *   - A create whose target exists, is non-empty, and is byte-identical to
 *     the create's contents passes through unchanged (the applier already
 *     treats this as a no-op success).
 *   - A create whose target exists, is non-empty, and DIFFERS from the
 *     create's contents is COERCED into a whole-file-replace edit:
 *     `isCreate: false`, `search` = the entire current file contents,
 *     `replace` = the create's contents. Because a string cannot contain
 *     two non-overlapping copies of its own entirety, this `search` is
 *     guaranteed to match exactly once, so the applier's edit branch
 *     applies it cleanly instead of declining.
 *
 * This function never throws (filesystem errors are treated defensively as
 * "not coercible, pass through unchanged") and never mutates its input; it
 * always returns a new array.
 *
 * @param workspace - The workspace root the phase is running against.
 * @param edits - The edits produced by `patchOpsToEdits`.
 * @returns A new array of edits with eligible creates coerced to edits.
 */
export function coerceCreatesToEdits(
  workspace: string,
  edits: readonly PatchEdit[],
): readonly PatchEdit[] {
  return edits.map((edit) => coerceOne(workspace, edit));
}

function coerceOne(workspace: string, edit: PatchEdit): PatchEdit {
  if (!edit.isCreate) {
    return edit;
  }

  if (isAbsolute(edit.filePath)) {
    return edit;
  }

  const normalizedRoot = normalize(workspace);
  const resolved = normalize(join(workspace, edit.filePath));
  const isInsideWorkspace =
    resolved === normalizedRoot || resolved.startsWith(`${normalizedRoot}/`);
  if (!isInsideWorkspace) {
    return edit;
  }

  let currentContent: string;
  try {
    if (!existsSync(resolved)) {
      return edit;
    }
    currentContent = readFileSync(resolved, "utf8");
  } catch {
    // Defensive: any read failure is treated as "not coercible" so the
    // original create op is left to the applier to handle/report.
    return edit;
  }

  if (currentContent === "") {
    // Empty existing file: leave as a create; the applier's empty-file
    // relaxation overwrites it deterministically without a search anchor.
    return edit;
  }

  if (currentContent === edit.replace) {
    // Byte-identical: the applier already treats this as a no-op success.
    return edit;
  }

  return {
    filePath: edit.filePath,
    search: currentContent,
    replace: edit.replace,
    isCreate: false,
    isMove: false,
  };
}
