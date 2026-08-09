import type { PatchEdit } from "./parse-patch";
import { predictBatchStates } from "./predict-batch-state";

/**
 * Deterministic anchor-expansion normalization pass for structured-patch
 * edits targeting TOML table headers.
 *
 * DEFECT FIXED: a model sometimes emits an `edit` whose `search` anchor is
 * just the bare table-header line (e.g. `[lints.clippy]`) while `replace`
 * renames or restructures the table (e.g. `[lints]`). Because the applier's
 * SEARCH/REPLACE substitution only replaces the matched anchor text, the
 * table's BODY (the key/value lines that followed the old header) is left
 * dangling in the file, orphaned under whatever header now follows it — a
 * malformed-but-often-silently-tolerated result (e.g. cargo tolerates stray
 * top-level keys after a broken `[lints]` table). This function detects that
 * narrow-anchor shape and deterministically EXPANDS the `search` anchor to
 * cover the entire table body (up to the next unrelated header, or EOF), so
 * the applier's substitution replaces the whole table atomically instead of
 * leaving stale content behind.
 *
 * ORDERING: this runs in `tryStructuredPhase` AFTER `coerceCreatesToEdits`
 * and BEFORE `applyEditsTransactionally`. It must run after
 * `coerceCreatesToEdits` because that pass can turn a `create` into a
 * whole-file-replace edit (whose `search` already covers far more than a
 * single header line, and which this function passes through unchanged);
 * running anchor-expansion first would waste work re-deriving what
 * `coerceCreatesToEdits` already produces correctly.
 *
 * CONTRACT: this function is PURE. It never throws (every filesystem or
 * matching failure degrades to "pass through unchanged"), never mutates its
 * input `edits` array or any individual edit object, and always returns a
 * NEW array.
 *
 * KNOWN LIMITATION: this pass now consumes the shared
 * `predict-batch-state.ts` fold (the same one `coerceCreatesToEdits` uses),
 * so it reads PREDICTED in-batch content instead of raw disk — a preceding
 * in-batch move or coerced whole-file-replace is reflected in the content it
 * expands against. The SOLE remaining limitation is the edit-before-move /
 * preceding partial-edit case: a partial edit's post-edit content is NOT
 * simulated, so a table edit whose target content was mutated by an earlier
 * partial edit in the same batch (including edit-before-move) may expand
 * against pre-edit bytes — identical to the inherited limitation in
 * `coerceCreatesToEdits`. This is considered uncommon and out of scope to
 * fully model here: the downstream applier's own not-found/ambiguous-match
 * handling degrades safely (the whole structured attempt rolls back and
 * falls back to the aider-text loop) if a stale anchor fails to match
 * cleanly, so no correctness guarantee is lost -- only the
 * deterministic-expansion optimization is skipped for that edit.
 *
 * @param workspace - The workspace root the phase is running against.
 * @param edits - The edits produced by `coerceCreatesToEdits`.
 * @returns A new array of edits with eligible narrow table-header anchors
 *   expanded to cover their full table body.
 */
export function expandTableHeaderAnchors(
  workspace: string,
  edits: readonly PatchEdit[],
): readonly PatchEdit[] {
  const bareHeaderGate = /^\[\[?[^\]\n]+\]\]?$/;
  const boundaryHeaderRegex = /^\[\[?[^\]\n]+\]\]?\s*(#.*)?$/;

  const stripHeaderBrackets = (trimmedHeader: string): string => {
    // Tolerate both `[table]` and `[[array]]` forms.
    return trimmedHeader.replace(/^\[\[?/, "").replace(/\]\]?$/, "");
  };

  const result: PatchEdit[] = [];

  for (const { edit, predictedContentForFilePath } of predictBatchStates(workspace, edits)) {
    if (edit.isCreate || edit.isMove) {
      result.push(edit);
      continue;
    }

    const trimmedSearchHeader = edit.search.trim();
    if (!bareHeaderGate.test(trimmedSearchHeader)) {
      result.push(edit);
      continue;
    }

    const replaceLines = edit.replace.split("\n");
    const firstNonEmptyReplaceLine = replaceLines.find((line) => line.trim() !== "");
    const trimmedReplaceHeader = (firstNonEmptyReplaceLine ?? "").trim();
    if (!bareHeaderGate.test(trimmedReplaceHeader)) {
      result.push(edit);
      continue;
    }

    // Replace-vs-append discriminator: same header on both sides means this
    // is an append-a-key edit, not a table-anchor rename/restructure. Do NOT
    // expand -- expanding here would delete the existing table body.
    if (trimmedReplaceHeader === trimmedSearchHeader) {
      result.push(edit);
      continue;
    }

    if (predictedContentForFilePath === null) {
      result.push(edit);
      continue;
    }

    const fileContent = predictedContentForFilePath;

    const lines = fileContent.split("\n");

    let headerIdx = -1;
    let matchCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? "").trimEnd() === trimmedSearchHeader) {
        matchCount++;
        headerIdx = i;
      }
    }

    if (matchCount !== 1) {
      result.push(edit);
      continue;
    }

    const anchorPath = stripHeaderBrackets(trimmedSearchHeader);

    let boundaryIdx = lines.length; // default: EOF (exclusive upper bound == lines.length)
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const candidate = lines[i] ?? "";
      const trimmedCandidate = candidate.trim();
      if (!boundaryHeaderRegex.test(trimmedCandidate)) {
        continue;
      }
      const candidatePath = stripHeaderBrackets(trimmedCandidate.replace(/\s*#.*$/, "").trim());
      const isSelfOrDescendant =
        candidatePath === anchorPath || candidatePath.startsWith(`${anchorPath}.`);
      if (!isSelfOrDescendant) {
        boundaryIdx = i;
        break;
      }
    }

    // Preserve final newline: when scanning to EOF and the file ends with a
    // trailing newline, the "\n"-split yields a trailing empty-string
    // element at lines.length - 1. Exclude it from the covered range.
    let endExclusive = boundaryIdx;
    if (
      boundaryIdx === lines.length &&
      lines.length > 0 &&
      (lines[lines.length - 1] ?? "") === ""
    ) {
      endExclusive = lines.length - 1;
    }

    const coveredLines = lines.slice(headerIdx, endExclusive);
    const expandedSearch = coveredLines.join("\n");

    if (expandedSearch === edit.search) {
      result.push(edit);
      continue;
    }

    const expandedEdit: PatchEdit = {
      filePath: edit.filePath,
      search: expandedSearch,
      replace: edit.replace,
      isCreate: false,
      isMove: false,
    };
    if (edit.toPath !== undefined) {
      result.push({ ...expandedEdit, toPath: edit.toPath });
    } else {
      result.push(expandedEdit);
    }
  }

  return result;
}
