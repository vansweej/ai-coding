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
 * NOTE ON DIVERGENCE (previously a documented limitation, now CLOSED): this
 * function still runs as an up-front diagnostic pass against PREDICTED
 * in-batch content (the shared `predict-batch-state.ts` fold), which is
 * useful for early, static analysis of a batch. However, prediction is no
 * longer on the PRODUCTION CORRECTNESS PATH: the authoritative table-header
 * rename expansion now happens at APPLY TIME, inside `applyPatch`
 * (`apply-patch-step.ts`, `options.expandTableAnchors`), via the pure
 * `expandTableHeaderAnchorAgainstContent` function below, which is invoked
 * against the ACTUAL on-disk bytes read immediately before that edit is
 * applied -- reflecting every preceding edit/move already executed
 * sequentially earlier in the same batch. Because the anchor that is
 * SEARCHED is now derived from the SAME bytes it is searched against, no
 * predicted-vs-disk divergence is possible, for any batch shape (moves,
 * multiple body mutations, interleaved partial edits, or the reverse
 * ordering). The `anchor-unexpandable` hard-abort decision is likewise made
 * against actual bytes at apply time. This up-front pass is retained only as
 * a non-authoritative diagnostic; do not rely on its output as the source of
 * truth for what gets searched at apply time.
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
  const result: PatchEdit[] = [];

  for (const { edit, predictedContentForFilePath } of predictBatchStates(workspace, edits, {
    simulatePartialEdits: true,
  })) {
    const expansion = expandTableHeaderAnchorAgainstContent(edit, predictedContentForFilePath);
    if (!expansion.ok) {
      return expansion;
    }
    result.push(expansion.value ?? edit);
  }

  return { ok: true, value: result };
}

const bareHeaderGate = /^\[\[?[^\]\n]+\]\]?$/;
const boundaryHeaderRegex = /^\[\[?[^\]\n]+\]\]?\s*(#.*)?$/;

function stripHeaderBrackets(trimmedHeader: string): string {
  // Tolerate both `[table]` and `[[array]]` forms.
  return trimmedHeader.replace(/^\[\[?/, "").replace(/\]\]?$/, "");
}

/**
 * PURE, filesystem-blind table-header rename anchor expander. Given a single
 * `PatchEdit` and the exact file content it will be searched against, decides
 * whether the edit is a confirmed table-header rename (a canonical bare
 * `search` header and a differing canonical bare `replace` header) and, if
 * so, expands `search` to cover the entire table body (up to the next
 * non-self-or-descendant header, or EOF) so the applier's substitution
 * replaces the whole table atomically instead of leaving a dangling body.
 *
 * This function is THE authoritative implementation of the expansion rule;
 * both the up-front diagnostic pass (`expandTableHeaderAnchors`, above) and
 * the apply-time seam (`applyPatch`'s `options.expandTableAnchors`, in
 * `apply-patch-step.ts`) delegate to it. It never reads the filesystem and
 * never calls `predictBatchStates` -- the caller supplies `fileContent`
 * directly, so the SAME anchor-derivation logic can be run against either a
 * predicted approximation (diagnostic) or the real on-disk bytes at apply
 * time (authoritative, correctness-bearing).
 *
 * Rules, preserved exactly from the original `expandTableHeaderAnchors`
 * behaviour:
 *   - `isCreate` / `isMove` edits, non-bare-header `search`, non-bare-header
 *     `replace`, and same-header append edits (`canonReplace === canonSearch`)
 *     all pass through unchanged: returns `{ ok: true, value: null }`
 *     (meaning "nothing to change, use the original edit").
 *   - The confirmed-rename shape (canonical bare `search` header AND a
 *     differing canonical bare `replace` header) is expanded: the table body
 *     is the header line through the last line before the next header that
 *     is neither the same table nor a descendant sub-table (a `[a.b]` header
 *     does not close `[a]`'s body), or EOF if no such boundary exists.
 *     Trailing final newline is preserved.
 *   - When the confirmed-rename anchor cannot be uniquely resolved against
 *     `fileContent` (`fileContent === null`, meaning the target is known to
 *     be absent, or the canonical header matches zero or more than one
 *     line), returns `{ ok: false, error }` with `reason:
 *     "anchor-unexpandable"` -- this HARD-ABORT class must never be
 *     silently guessed.
 *   - When the expanded search would equal the original `edit.search`
 *     (nothing to expand), returns `{ ok: true, value: null }`.
 *
 * @param edit - The candidate edit to (maybe) expand.
 * @param fileContent - The exact content the expanded anchor will be
 *   searched against (predicted, for the diagnostic pass; on-disk, for the
 *   authoritative apply-time seam), or `null` if the target is known absent.
 * @returns `{ ok: true, value: expandedEdit | null }` (`null` means pass the
 *   original edit through unchanged), or `{ ok: false, error }` for the
 *   confirmed-rename-unresolvable hard-abort class.
 */
export function expandTableHeaderAnchorAgainstContent(
  edit: PatchEdit,
  fileContent: string | null,
): Result<PatchEdit | null, AnchorExpansionError> {
  if (edit.isCreate || edit.isMove) {
    return { ok: true, value: null };
  }

  const canonSearch = canonicalizeHeader(edit.search);
  if (!bareHeaderGate.test(canonSearch)) {
    return { ok: true, value: null };
  }

  const replaceLines = edit.replace.split("\n");
  const firstNonEmptyReplaceLine = replaceLines.find((line) => line.trim() !== "");
  const canonReplace = canonicalizeHeader(firstNonEmptyReplaceLine ?? "");
  if (!bareHeaderGate.test(canonReplace)) {
    return { ok: true, value: null };
  }

  // Replace-vs-append discriminator: same canonical header on both sides
  // means this is an append-a-key edit, not a table-anchor rename. Do NOT
  // expand -- expanding here would delete the existing table body.
  if (canonReplace === canonSearch) {
    return { ok: true, value: null };
  }

  // Confirmed-rename shape from here on: canonical bare search header,
  // canonical bare replace header, and the two canonical headers differ.
  if (fileContent === null) {
    return {
      ok: false,
      error: {
        filePath: edit.filePath,
        reason: "anchor-unexpandable",
        message: `Confirmed table-header rename anchor "${edit.search.trim()}" targets "${edit.filePath}", which predicts absent (e.g. an edit emitted against a pre-move source path); cannot uniquely resolve — aborting.`,
      },
    };
  }

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
  if (boundaryIdx === lines.length && lines.length > 0 && (lines[lines.length - 1] ?? "") === "") {
    endExclusive = lines.length - 1;
  }

  const coveredLines = lines.slice(headerIdx, endExclusive);
  const expandedSearch = coveredLines.join("\n");

  if (expandedSearch === edit.search) {
    return { ok: true, value: null };
  }

  const expandedEdit: PatchEdit = {
    filePath: edit.filePath,
    search: expandedSearch,
    replace: edit.replace,
    isCreate: false,
    isMove: false,
  };
  if (edit.toPath !== undefined) {
    return { ok: true, value: { ...expandedEdit, toPath: edit.toPath } };
  }
  return { ok: true, value: expandedEdit };
}
