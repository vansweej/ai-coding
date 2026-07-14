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
 */
export interface PatchEdit {
  readonly filePath: string;
  readonly search: string;
  readonly replace: string;
  readonly isCreate: boolean;
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
      line.startsWith(">>>>>>> REPLACE")
    ) {
      return {
        ok: false,
        error: {
          message: "Unexpected marker line without file-path header",
          fragment: line,
        },
      };
    }

    // This line is the file path
    const filePath = line.trim();
    i++;

    // Expect <<<<<<< SEARCH marker
    if (i >= lines.length) {
      return {
        ok: false,
        error: {
          message: `File "${filePath}" is missing SEARCH marker`,
          fragment: filePath,
        },
      };
    }

    const searchMarker = lines[i] ?? "";
    if (searchMarker !== "<<<<<<< SEARCH") {
      return {
        ok: false,
        error: {
          message: `File "${filePath}" is missing "<<<<<<< SEARCH" marker`,
          fragment: searchMarker,
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
    });
  }

  return { ok: true, value: edits };
}
