import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { expandTableHeaderAnchorAgainstContent } from "./expand-table-anchor";
import type { PatchEdit } from "./parse-patch";
import { type PathSafetyError, assertInsideWorkspace } from "./patch-path-guard";
import { matchTolerantAnchor } from "./tolerant-anchor-match";

/**
 * Details about a successfully applied patch.
 */
export interface AppliedFile {
  readonly filePath: string;
  readonly created: boolean;
}

/**
 * Error details when patch application fails.
 */
export interface PatchApplyError {
  readonly filePath: string;
  readonly reason: "not-found" | "ambiguous" | "exists" | "io" | "anchor-unexpandable";
  readonly message: string;
}

/**
 * Options controlling `applyPatch` behaviour.
 */
export interface ApplyPatchOptions {
  /**
   * When `true`, a confirmed table-header rename anchor (a bare `search`
   * header and a differing bare `replace` header, e.g. `[lints.clippy]` ->
   * `[lints]`) is expanded to cover its full table body IMMEDIATELY BEFORE
   * being searched, against the file content just read from disk for that
   * edit -- i.e. authoritatively, at apply time, reflecting every preceding
   * edit/move already applied earlier in this same sequential batch. This is
   * the fix for the predicted-vs-disk anchor divergence: because the anchor
   * that is searched is derived from the SAME bytes it is searched against,
   * no approximation-vs-reality mismatch is possible. Defaults to `false` so
   * existing callers (e.g. the incremental aider-text retry loop, which
   * re-issues raw model-authored edits one at a time and does not want
   * table-header expansion semantics) are unaffected.
   */
  readonly expandTableAnchors?: boolean;

  /**
   * When `true`, EDIT ops whose exact `search` yields zero matches fall back
   * to the language-agnostic blank-line-bounded tolerant matcher (see
   * `tolerant-anchor-match.ts`). Default `false` -- the text-loop caller
   * passes no options and is unaffected.
   */
  readonly tolerantAnchorMatch?: boolean;
}

/**
 * Apply a series of patch edits to the filesystem.
 *
 * For each edit:
 *   - If `isMove` is true: relocate the file or directory at `filePath` to
 *     `toPath` via `fs.rename`. Both endpoints are validated against the
 *     workspace root. If the source is already gone and the destination
 *     already exists, this is a no-op success (idempotent retry); if the
 *     destination already exists while the source still exists, this fails
 *     with `exists`; if neither exists, this fails with `not-found`.
 *   - Else if `isCreate` is true: write the replacement text to a new file. If the
 *     file already exists with byte-identical content, this is a no-op
 *     success (idempotent retry); if it exists with different content, this
 *     fails.
 *   - Otherwise: read the current file, OPTIONALLY expand a confirmed
 *     table-header rename anchor against those just-read bytes (see
 *     `options.expandTableAnchors`), verify the (possibly-expanded) search
 *     anchor occurs exactly once, and replace it with the replacement text.
 *
 * The search anchor must match exactly and occur exactly once in the file. If the anchor
 * is not found, returns a `not-found` error. If the anchor appears multiple times,
 * returns an `ambiguous` error. When `options.expandTableAnchors` is enabled and a
 * confirmed table-header rename anchor cannot be uniquely resolved against the current
 * on-disk bytes, returns an `anchor-unexpandable` error instead of guessing.
 *
 * All paths are validated against the workspace root to prevent `../` escapes or
 * absolute-path attacks.
 *
 * This function never throws — all failures are surfaced as `Result` errors so they
 * can feed into a repair loop.
 *
 * @param root - The workspace root directory under which all edits are applied.
 * @param edits - Array of patch edits to apply.
 * @param options - Optional behaviour flags; see `ApplyPatchOptions`.
 * @returns A `Promise<Result<AppliedFile[], PatchApplyError>>` — the list of applied files
 *          on success, or the first error encountered on failure.
 */
export async function applyPatch(
  root: string,
  edits: readonly PatchEdit[],
  options?: ApplyPatchOptions,
): Promise<{ ok: true; value: AppliedFile[] } | { ok: false; error: PatchApplyError }> {
  const applied: AppliedFile[] = [];

  for (const edit of edits) {
    // Validate and resolve the path
    const pathValidation = assertInsideWorkspace(root, edit.filePath);
    if (!pathValidation.ok) {
      return {
        ok: false,
        error: {
          filePath: edit.filePath,
          reason: "io",
          message: pathValidation.error.message,
        },
      };
    }

    const absolutePath = pathValidation.value;

    try {
      if (edit.isMove) {
        // Move/rename mode: relocate a file or directory via fs.rename.
        // The destination path must ALSO be validated against the workspace
        // root -- the guard above only covers `edit.filePath` (the source).
        const toPath = edit.toPath ?? "";
        const destValidation = assertInsideWorkspace(root, toPath);
        if (!destValidation.ok) {
          return {
            ok: false,
            error: {
              filePath: toPath,
              reason: "io",
              message: destValidation.error.message,
            },
          };
        }
        const destAbsolute = destValidation.value;

        const sourceExists = existsSync(absolutePath);
        const destExists = existsSync(destAbsolute);

        // Idempotent-under-retry: a multi-step phase applies each step's
        // patch as it succeeds; if a LATER step in the same round fails, the
        // retry re-issues ALL steps (including this already-applied move) as
        // one combined edit. If the source is already gone and the
        // destination is already there, treat the move as already satisfied
        // rather than failing with "not-found" (mirrors create-mode's
        // byte-identical no-op above).
        if (!sourceExists && destExists) {
          applied.push({ filePath: toPath, created: false });
          continue;
        }

        if (!sourceExists && !destExists) {
          return {
            ok: false,
            error: {
              filePath: edit.filePath,
              reason: "not-found",
              message: `File "${edit.filePath}" not found`,
            },
          };
        }

        if (destExists) {
          return {
            ok: false,
            error: {
              filePath: toPath,
              reason: "exists",
              message: `Move destination "${toPath}" already exists`,
            },
          };
        }

        // Create the destination's parent directories if needed, then
        // rename. fs.rename works for both files and directories.
        mkdirSync(dirname(destAbsolute), { recursive: true });
        renameSync(absolutePath, destAbsolute);
        applied.push({ filePath: toPath, created: false });
      } else if (edit.isCreate) {
        // File creation mode: fail if the file already exists with DIFFERENT
        // content. If the content is byte-identical, treat this as a no-op
        // success instead of an error -- this makes create-mode idempotent
        // under retry. It matters because a multi-step phase applies each
        // step's patch immediately as it succeeds; if a LATER step in the
        // same round fails, the retry re-issues ALL steps (including this
        // already-applied create) as one combined edit. Without this,
        // re-issuing an already-satisfied create step would abort the retry
        // instead of letting it proceed to the step that actually needs
        // fixing.
        if (existsSync(absolutePath)) {
          const currentContent = readFileSync(absolutePath, "utf8");
          if (currentContent === edit.replace) {
            applied.push({ filePath: edit.filePath, created: false });
            continue;
          }
          // An EMPTY existing file has no content to conflict with, so a
          // create op is allowed to overwrite it deterministically instead
          // of declining. This mirrors the byte-identical no-op case above
          // but for the (common, post-move) case where the target is a
          // zero-byte placeholder rather than an exact content match.
          if (currentContent === "") {
            writeFileSync(absolutePath, edit.replace, "utf8");
            applied.push({ filePath: edit.filePath, created: false });
            continue;
          }
          return {
            ok: false,
            error: {
              filePath: edit.filePath,
              reason: "exists",
              message: `File "${edit.filePath}" already exists; cannot create`,
            },
          };
        }

        // Create parent directories if needed
        mkdirSync(dirname(absolutePath), { recursive: true });

        // Write the replacement text as the file content
        writeFileSync(absolutePath, edit.replace, "utf8");
        applied.push({ filePath: edit.filePath, created: true });
      } else {
        // File modification mode: read, verify anchor, and replace
        if (!existsSync(absolutePath)) {
          return {
            ok: false,
            error: {
              filePath: edit.filePath,
              reason: "not-found",
              message: `File "${edit.filePath}" not found`,
            },
          };
        }

        const currentContent = readFileSync(absolutePath, "utf8");
        // Tolerant offsets are valid ONLY against this per-iteration fresh
        // read of currentContent. Hoisting this read out of the loop would
        // corrupt multi-edit-same-file batches.
        // OPTIONALLY expand a confirmed table-header rename anchor
        // authoritatively, against the bytes just read from disk -- this is
        // the apply-time fix for the predicted-vs-disk anchor divergence.
        // `null` value means "nothing to expand, use the original edit
        // unchanged"; an error means the confirmed-rename shape could not be
        // uniquely resolved even against real bytes, which hard-aborts.
        let effectiveEdit = edit;
        if (options?.expandTableAnchors === true) {
          const expansion = expandTableHeaderAnchorAgainstContent(edit, currentContent);
          if (!expansion.ok) {
            return {
              ok: false,
              error: {
                filePath: edit.filePath,
                reason: "anchor-unexpandable",
                message: expansion.error.message,
              },
            };
          }
          if (expansion.value !== null) {
            effectiveEdit = expansion.value;
          }
        }

        // Count occurrences of the search anchor
        const searchCount = (
          currentContent.match(new RegExp(escapeRegExp(effectiveEdit.search), "g")) ?? []
        ).length;

        if (searchCount === 0) {
          // Before declaring the anchor unrecoverable, OPTIONALLY attempt the
          // language-agnostic blank-line-bounded tolerant matcher. This
          // consumes the RAW `edit.search`, NOT `effectiveEdit.search` --
          // avoids stacking the table-expander paraphrase and the tolerant
          // paraphrase on the same TOML-table shape.
          let tolerantOutcome: "not-attempted" | "not-found" | "ambiguous" | "applied" =
            "not-attempted";
          if (options?.tolerantAnchorMatch === true) {
            const tolerantResult = matchTolerantAnchor(currentContent, edit.search);
            if (tolerantResult.ok) {
              const { startOffset, endOffset } = tolerantResult.value;
              const splicedContent =
                currentContent.slice(0, startOffset) +
                edit.replace +
                currentContent.slice(endOffset);
              writeFileSync(absolutePath, splicedContent, "utf8");
              applied.push({ filePath: edit.filePath, created: false });
              tolerantOutcome = "applied";
              continue;
            }
            tolerantOutcome = tolerantResult.error.reason;
          }

          // ANCHOR_DEBUG is a deliberate, PERMANENT env-gated diagnostic
          // (not a temporary probe) -- retained for future anchor-mismatch
          // investigations. It fires on the FINAL failure path only: once
          // the tolerant matcher (if attempted) has also declined.
          /* v8 ignore start -- stderr-only, env-gated diagnostic with no return-value effect */
          if (process.env.ANCHOR_DEBUG === "1") {
            const sep = "\n========================================\n";
            process.stderr.write(
              `${sep}ANCHOR-DEBUG: Search anchor not found${sep}filePath: ${edit.filePath}\nabsolutePath: ${absolutePath}\nisMove: ${edit.isMove}  isCreate: ${edit.isCreate}\nexpandTableAnchors option: ${options?.expandTableAnchors === true}\nexpander fired (raw !== effective): ${edit.search !== effectiveEdit.search}\ntolerantAnchorMatch option: ${options?.tolerantAnchorMatch === true}\ntolerant outcome: ${tolerantOutcome}\n----- RAW edit.search (${JSON.stringify(edit.search).length} chars) -----\n${JSON.stringify(edit.search)}\n----- EFFECTIVE effectiveEdit.search -----\n${JSON.stringify(effectiveEdit.search)}\n----- ACTUAL on-disk currentContent bytes -----\n${JSON.stringify(currentContent)}\n----- currentContent (pretty) -----\n${currentContent}${sep}`,
            );
          }
          /* v8 ignore stop */

          if (tolerantOutcome === "ambiguous") {
            return {
              ok: false,
              error: {
                filePath: edit.filePath,
                reason: "ambiguous",
                message: `Search anchor is ambiguous in "${edit.filePath}" (tolerant match)`,
              },
            };
          }

          return {
            ok: false,
            error: {
              filePath: edit.filePath,
              reason: "not-found",
              message: `Search anchor not found in "${edit.filePath}"`,
            },
          };
        }

        if (searchCount > 1) {
          return {
            ok: false,
            error: {
              filePath: edit.filePath,
              reason: "ambiguous",
              message: `Search anchor appears ${searchCount} times in "${edit.filePath}"; must be unique`,
            },
          };
        }

        // Replace the anchor with the replacement text. A replacer FUNCTION is used
        // (rather than passing edit.replace as a string) because a string second
        // argument makes String.prototype.replace interpret $&, $1, $$, $`, and $'
        // as special patterns; a replacer function returns the replacement verbatim.
        const newContent = currentContent.replace(
          effectiveEdit.search,
          () => effectiveEdit.replace,
        );
        writeFileSync(absolutePath, newContent, "utf8");
        applied.push({ filePath: edit.filePath, created: false });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          filePath: edit.filePath,
          reason: "io",
          message: `I/O error while applying patch to "${edit.filePath}": ${message}`,
        },
      };
    }
  }

  return { ok: true, value: applied };
}

/**
 * Escape special regex characters in a string for use in RegExp.
 * This ensures the search anchor is treated as a literal string, not a regex pattern.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
