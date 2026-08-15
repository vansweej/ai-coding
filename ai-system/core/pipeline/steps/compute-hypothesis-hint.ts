/**
 * Human-readable hypothesis hint for a failed SEARCH anchor.
 *
 * When every non-empty line in `search` shares the same non-zero leading
 * whitespace (uniformly indented), it is likely the model copied content
 * verbatim from an indented context while the actual file content sits at a
 * different indentation level. This hint is appended to the
 * "Search anchor not found" error so an LLM (or a human debugging the run)
 * can recognise the cause without inspecting raw bytes.
 */

/**
 * Compute a human-readable hypothesis hint for a failed SEARCH anchor.
 *
 * Returns a non-empty string when every non-empty line in `search` has the
 * same non-zero leading whitespace (uniformly indented). Returns an empty
 * string when the block is empty, whitespace-only, has mixed indentation, or
 * has no leading whitespace on the first non-empty line. Never throws.
 *
 * @param search - The raw search anchor text from the aider-style patch.
 */
export function computeHypothesisHint(search: string): string {
  const lines = search.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);

  if (nonEmptyLines.length === 0) return "";

  const leadingWs = (line: string): string => /^([ \t]*)/.exec(line)?.[1] ?? "";

  const firstIndent = leadingWs(nonEmptyLines[0] ?? "");
  if (firstIndent.length === 0) return "";

  if (!nonEmptyLines.every((line) => leadingWs(line) === firstIndent)) return "";

  return `search block is uniformly indented by ${firstIndent.length} leading whitespace character(s) — the file may contain the same text at a different indentation level`;
}
