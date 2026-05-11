/**
 * Split a text string into pieces that each respect a character limit.
 *
 * Uses a three-tier strategy so the invariant holds for any input:
 *
 *   1. **Blank lines** — split on `\n{2,}` and accumulate adjacent small
 *      pieces. Handles normal source files with blank-line-separated blocks.
 *
 *   2. **Single newlines** — if a paragraph (no blank lines) is still
 *      oversized, split on `\n` and accumulate adjacent small lines.
 *      Handles dense functions or config blocks with no blank lines.
 *
 *   3. **Character boundary** — if a single line is still oversized, split
 *      at the last whitespace before `maxChars` (or hard-slice at `maxChars`
 *      if no whitespace is found). Handles minified JS, long data literals,
 *      and other pathological single-line content.
 *
 * **Invariant:** every returned string has `.length <= maxChars`.
 *
 * @param text     - Input text (may exceed maxChars).
 * @param maxChars - Hard cap on the character count of each returned piece.
 * @returns Ordered array of non-empty trimmed pieces, each `<= maxChars`.
 */
export function splitOversized(text: string, maxChars: number): readonly string[] {
  if (text.length <= maxChars) return [text];

  const result: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = "";

  for (const para of paragraphs) {
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current.trim().length > 0) {
        result.push(current.trim());
      }
      if (para.length <= maxChars) {
        current = para;
      } else {
        // Tier 2: paragraph is oversized — split on single newlines
        const lineParts = splitOnLines(para, maxChars);
        for (let i = 0; i < lineParts.length - 1; i++) {
          const piece = lineParts[i];
          if (piece !== undefined && piece.trim().length > 0) {
            result.push(piece.trim());
          }
        }
        current = lineParts[lineParts.length - 1] ?? "";
      }
    }
  }

  if (current.trim().length > 0) {
    result.push(current.trim());
  }

  return result;
}

/**
 * Split a paragraph (no blank lines) into pieces on single newlines,
 * falling through to character-level splitting for lines that still
 * exceed the limit (e.g. minified JS, long data literals).
 */
function splitOnLines(text: string, maxChars: number): string[] {
  const lines = text.split("\n");
  const result: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current.trim().length > 0) {
        result.push(current);
      }
      if (line.length <= maxChars) {
        current = line;
      } else {
        // Tier 3: single line exceeds the limit — hard split
        const parts = hardSplit(line, maxChars);
        for (let i = 0; i < parts.length - 1; i++) {
          const piece = parts[i];
          if (piece !== undefined) {
            result.push(piece);
          }
        }
        current = parts[parts.length - 1] ?? "";
      }
    }
  }

  if (current.length > 0) {
    result.push(current);
  }

  return result;
}

/**
 * Last-resort character-level split. Tries to break at the last whitespace
 * before `maxChars`; if no whitespace is found in the second half of the
 * slice, hard-slices at `maxChars`.
 *
 * Guarantees: every returned piece has `.length <= maxChars` and the
 * function always makes forward progress (advances by at least 1 character).
 */
function hardSplit(text: string, maxChars: number): string[] {
  const result: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    if (offset + maxChars >= text.length) {
      result.push(text.slice(offset));
      break;
    }

    const slice = text.slice(offset, offset + maxChars);
    const lastSpace = slice.lastIndexOf(" ");

    if (lastSpace > maxChars / 2) {
      // Break at the last whitespace in the second half of the slice
      result.push(text.slice(offset, offset + lastSpace));
      offset += lastSpace + 1; // skip the space itself
    } else {
      // No good whitespace boundary — hard-slice
      result.push(slice);
      offset += maxChars;
    }
  }

  return result;
}
