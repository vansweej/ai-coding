import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { PatchEdit } from "./parse-patch";
import { type PathSafetyError, assertInsideWorkspace } from "./patch-path-guard";

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
  readonly reason: "not-found" | "ambiguous" | "exists" | "io";
  readonly message: string;
}

/**
 * Apply a series of patch edits to the filesystem.
 *
 * For each edit:
 *   - If `isCreate` is true: write the replacement text to a new file. If the
 *     file already exists with byte-identical content, this is a no-op
 *     success (idempotent retry); if it exists with different content, this
 *     fails.
 *   - Otherwise: read the current file, verify the search anchor occurs exactly once,
 *     and replace it with the replacement text.
 *
 * The search anchor must match exactly and occur exactly once in the file. If the anchor
 * is not found, returns a `not-found` error. If the anchor appears multiple times,
 * returns an `ambiguous` error.
 *
 * All paths are validated against the workspace root to prevent `../` escapes or
 * absolute-path attacks.
 *
 * This function never throws — all failures are surfaced as `Result` errors so they
 * can feed into a repair loop.
 *
 * @param root - The workspace root directory under which all edits are applied.
 * @param edits - Array of patch edits to apply.
 * @returns A `Promise<Result<AppliedFile[], PatchApplyError>>` — the list of applied files
 *          on success, or the first error encountered on failure.
 */
export async function applyPatch(
  root: string,
  edits: readonly PatchEdit[],
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
      if (edit.isCreate) {
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

        // Count occurrences of the search anchor
        const searchCount = (currentContent.match(new RegExp(escapeRegExp(edit.search), "g")) ?? [])
          .length;

        if (searchCount === 0) {
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

        // Replace the anchor with the replacement text
        const newContent = currentContent.replace(edit.search, edit.replace);
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
