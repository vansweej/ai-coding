/**
 * A single patch edit extracted from aider-style SEARCH/REPLACE blocks.
 *
 * The aider grammar uses fenced blocks with markers:
 * ```
 * <file-path>
 * <<<<<<< SEARCH
 * <exact anchor text to find>
 * =======
 * <replacement text>
 * >>>>>>> REPLACE
 * ```
 *
 * When the SEARCH body is empty (anchor is blank), `isCreate` is set to true,
 * indicating the file should be created with the replacement text as its content.
 *
 * A MOVE block relocates a file or directory instead of editing content. It is
 * isomorphic to the SEARCH/REPLACE shape (same header + separator + terminator
 * rhythm) so the model reuses grammar it already knows:
 * ```
 * <from-path>
 * <<<<<<< MOVE
 * =======
 * <to-path>
 * >>>>>>> MOVE
 * ```
 * For a move edit, `filePath` is the source path, `toPath` is the destination,
 * `isMove` is `true`, and `search`/`replace` are both empty strings (unused).
 */
export interface PatchEdit {
  readonly filePath: string;
  readonly search: string;
  readonly replace: string;
  readonly isCreate: boolean;
  readonly isMove: boolean;
  readonly toPath?: string;
}

/**
 * Strip a single enclosing code fence from raw model output before parsing.
 *
 * Some models wrap their aider-style patch output in a Markdown code fence
 * (e.g. ```bash ... ```), which breaks `parsePatch` because the fence's
 * opening line is misread as a file-path header. This function removes
 * exactly one OUTER fence -- an opening line that is ``` optionally followed
 * by a language tag, and a matching closing ``` line at the end -- and
 * returns the content between them unchanged. If the input is not fenced
 * this way, it is returned unchanged. Inner fences (e.g. inside a REPLACE
 * body) are never touched; only the enclosing wrapper is stripped.
 *
 * @param raw - Raw model output, possibly wrapped in a single code fence.
 * @returns The de-fenced content, or the original input if it was not fenced.
 */
export function stripEnclosingFence(raw: string): string {
  const trimmed = raw.trim();
  const lines = trimmed.split("\n");

  if (lines.length < 2) {
    return raw;
  }

  const firstLine = lines[0] ?? "";
  const lastLine = lines[lines.length - 1] ?? "";

  const openerMatches = /^```[a-zA-Z0-9_-]*$/.test(firstLine.trim());
  const closerMatches = lastLine.trim() === "```";

  if (!openerMatches || !closerMatches) {
    return raw;
  }

  return lines.slice(1, -1).join("\n");
}

/**
 * Error details when patch parsing fails.
 */
export interface PatchParseError {
  readonly message: string;
  readonly fragment: string;
}

/**
 * Parse aider-style SEARCH/REPLACE patch blocks from raw text.
 *
 * Expected format for each edit:
 * ```
 * <file-path>
 * <<<<<<< SEARCH
 * <exact anchor text>
 * =======
 * <replacement text>
 * >>>>>>> REPLACE
 * ```
 *
 * Grammar rules:
 *   - Each edit begins with a file-path line (non-empty, not a marker).
 *   - Followed by a line containing exactly `<<<<<<< SEARCH`.
 *   - The SEARCH body (anchor text) follows until a line containing exactly `=======`.
 *   - The REPLACE body (replacement text) follows until a line containing exactly `>>>>>>> REPLACE`.
 *   - When SEARCH body is empty, `isCreate` is set to true (file creation mode).
 *   - Replacement text may contain lines that look like markers but are not on their own lines.
 *
 * @param raw - Raw patch text containing one or more aider-style blocks.
 * @returns A `Result<PatchEdit[], PatchParseError>` — ok with parsed edits on success,
 *          error with a descriptive message and offending fragment on failure.
 */
export function parsePatch(
  raw: string,
): { ok: true; value: PatchEdit[] } | { ok: false; error: PatchParseError } {
  const edits: PatchEdit[] = [];
  const lines = raw.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Skip empty lines between edits
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Check if this line is a marker (should not be a file path)
    if (
      line.startsWith("<<<<<<< SEARCH") ||
      line.startsWith("=======") ||
      line.startsWith(">>>>>>> REPLACE") ||
      line.startsWith("<<<<<<< MOVE") ||
      line.startsWith(">>>>>>> MOVE")
    ) {
      return {
        ok: false,
        error: {
          message: "Unexpected marker line without file-path header",
          fragment: line,
        },
      };
    }

    // This line is the file path (or, for a MOVE block, the source path)
    const filePath = line.trim();
    i++;

    // Expect either <<<<<<< SEARCH or <<<<<<< MOVE
    if (i >= lines.length) {
      return {
        ok: false,
        error: {
          message: `File "${filePath}" is missing SEARCH marker`,
          fragment: filePath,
        },
      };
    }

    const blockMarker = lines[i] ?? "";

    if (blockMarker === "<<<<<<< MOVE") {
      i++;

      // The body between <<<<<<< MOVE and ======= must be empty for a move.
      const moveSearchLines: string[] = [];
      while (i < lines.length) {
        const currentLine = lines[i] ?? "";
        if (currentLine === "=======") {
          break;
        }
        moveSearchLines.push(currentLine);
        i++;
      }

      if (i >= lines.length) {
        return {
          ok: false,
          error: {
            message: `File "${filePath}" has unterminated MOVE block (missing "=======" separator)`,
            fragment: filePath,
          },
        };
      }

      // Skip the separator line
      i++;

      // Collect the to-path lines until the MOVE terminator
      const toPathLines: string[] = [];
      while (i < lines.length) {
        const currentLine = lines[i] ?? "";
        if (currentLine === ">>>>>>> MOVE") {
          break;
        }
        toPathLines.push(currentLine);
        i++;
      }

      if (i >= lines.length) {
        return {
          ok: false,
          error: {
            message: `File "${filePath}" has unterminated MOVE block (missing ">>>>>>> MOVE" marker)`,
            fragment: filePath,
          },
        };
      }

      // Skip the end marker
      i++;

      const toPath = toPathLines.join("\n").trim();
      if (toPath === "") {
        return {
          ok: false,
          error: {
            message: `File "${filePath}" has an empty MOVE destination path`,
            fragment: filePath,
          },
        };
      }

      edits.push({
        filePath,
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath,
      });

      continue;
    }

    if (blockMarker !== "<<<<<<< SEARCH") {
      return {
        ok: false,
        error: {
          message: `File "${filePath}" is missing "<<<<<<< SEARCH" marker`,
          fragment: blockMarker,
        },
      };
    }
    i++;

    // Collect SEARCH body until we hit the separator
    const searchLines: string[] = [];
    while (i < lines.length) {
      const currentLine = lines[i] ?? "";
      if (currentLine === "=======") {
        break;
      }
      searchLines.push(currentLine);
      i++;
    }

    if (i >= lines.length) {
      return {
        ok: false,
        error: {
          message: `File "${filePath}" has unterminated SEARCH block (missing "=======" separator)`,
          fragment: filePath,
        },
      };
    }

    // Skip the separator line
    i++;

    // Collect REPLACE body until we hit the end marker
    const replaceLines: string[] = [];
    while (i < lines.length) {
      const currentLine = lines[i] ?? "";
      if (currentLine === ">>>>>>> REPLACE") {
        break;
      }
      replaceLines.push(currentLine);
      i++;
    }

    if (i >= lines.length) {
      return {
        ok: false,
        error: {
          message: `File "${filePath}" has unterminated REPLACE block (missing ">>>>>>> REPLACE" marker)`,
          fragment: filePath,
        },
      };
    }

    // Skip the end marker
    i++;

    // Build the search and replace strings
    const search = searchLines.join("\n");
    const replace = replaceLines.join("\n");
    const isCreate = search.trim() === "";

    edits.push({
      filePath,
      search,
      replace,
      isCreate,
      isMove: false,
    });
  }

  return { ok: true, value: edits };
}
