import type { Result } from "@ai-coding/shared";

import type { PatchEdit } from "./parse-patch";
import { canonicalizeHeader, predictBatchStates } from "./predict-batch-state";

/**
 * Signals a confirmed table-header rename anchor (a bare `search` header and
 * a differing bare `replace` header) that could not be uniquely resolved
 * against the predicted file content — either the target predicts absent,
 * or the canonical header matched zero or more than one line. This class of
 * failure must HARD-ABORT the phase (no aider-text fallback): the anchor
 * shape is well-understood, so silently degrading risks the same
 * dangling-table-body defect this module exists to prevent.
 */
export interface AnchorExpansionError {
  readonly filePath: string;
  readonly reason: "anchor-unexpandable";
  readonly message: string;
}

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
 * matching failure degrades to "pass through unchanged", EXCEPT the
 * confirmed-rename-unresolvable class described below, which hard-declines
 * via an error `Result`), never mutates its input `edits` array or any
 * individual edit object, and always returns a NEW array on success.
 *
 * HARD-ABORT CLASS: only the confirmed-rename shape — a canonical bare
 * `search` header AND a canonical bare `replace` header that differ — can
 * fail this function. When that shape's anchor cannot be uniquely resolved
 * (the target file predicts absent, or the canonical header matches zero or
 * more than one line), this function returns `{ ok: false, error }` with
 * `reason: "anchor-unexpandable"` instead of guessing. Every OTHER shape
 * (non-header search, append-same-header, non-rename edits, creates, moves)
 * still passes through unchanged in the ok array; generic apply failures
 * elsewhere in the pipeline are unaffected by this hard-abort.
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
 * @returns A `Result` whose ok value is a new array of edits with eligible
 *   narrow table-header anchors expanded to cover their full table body, or
 *   an `AnchorExpansionError` when a confirmed-rename anchor cannot be
 *   uniquely resolved.
 */
export function expandTableHeaderAnchors(
  workspace: string,
  edits: readonly PatchEdit[],
): Result<readonly PatchEdit[], AnchorExpansionError> {
  const bareHeaderGate = /^\[\[?[^\]\n]+\]\]?$/;
  const boundaryHeaderRegex = /^\[\[?[^\]\n]+\]\]?\s*(#.*)?$/;

  const stripHeaderBrackets = (trimmedHeader: string): string => {
    // Tolerate both `[table]` and `[[array]]` forms.
    return trimmedHeader.replace(/^\[\[?/, "").replace(/\]\]?$/, "");
  };

  const result: PatchEdit[] = [];

  for (const { edit, predictedContentForFilePath } of predictBatchStates(workspace, edits, {
    simulatePartialEdits: true,
  })) {
    if (edit.isCreate || edit.isMove) {
      result.push(edit);
      continue;
    }

    const canonSearch = canonicalizeHeader(edit.search);
    if (!bareHeaderGate.test(canonSearch)) {
      result.push(edit);
      continue;
    }

    const replaceLines = edit.replace.split("\n");
    const firstNonEmptyReplaceLine = replaceLines.find((line) => line.trim() !== "");
    const canonReplace = canonicalizeHeader(firstNonEmptyReplaceLine ?? "");
    if (!bareHeaderGate.test(canonReplace)) {
      result.push(edit);
      continue;
    }

    // Replace-vs-append discriminator: same canonical header on both sides
    // means this is an append-a-key edit, not a table-anchor rename. Do NOT
    // expand -- expanding here would delete the existing table body.
    if (canonReplace === canonSearch) {
      result.push(edit);
      continue;
    }

    // Confirmed-rename shape from here on: canonical bare search header,
    // canonical bare replace header, and the two canonical headers differ.
    if (predictedContentForFilePath === null) {
      return {
        ok: false,
        error: {
          filePath: edit.filePath,
          reason: "anchor-unexpandable",
          message: `Confirmed table-header rename anchor "${edit.search.trim()}" targets "${edit.filePath}", which predicts absent (e.g. an edit emitted against a pre-move source path); cannot uniquely resolve — aborting.`,
        },
      };
    }

    const fileContent = predictedContentForFilePath;

    const lines = fileContent.split("\n");

    let headerIdx = -1;
    let matchCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (canonicalizeHeader(lines[i] ?? "") === canonSearch) {
        matchCount++;
        headerIdx = i;
      }
    }

    if (matchCount !== 1) {
      return {
        ok: false,
        error: {
          filePath: edit.filePath,
          reason: "anchor-unexpandable",
          message: `Confirmed table-header rename anchor "${edit.search.trim()}" matched ${matchCount} candidate header lines in "${edit.filePath}"; a unique anchor is required — aborting.`,
        },
      };
    }

    const anchorPath = stripHeaderBrackets(canonSearch);

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

  return { ok: true, value: result };
}
