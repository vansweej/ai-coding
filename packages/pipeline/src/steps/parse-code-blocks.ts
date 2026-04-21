/** Shape of a single parsed code block extracted from LLM output. */
export interface ParsedCodeBlock {
  readonly language: string;
  readonly filePath: string;
  readonly content: string;
}

/**
 * Parse fenced code blocks from text and extract file paths.
 *
 * Expected format for each block:
 * ```<language> <file-path>
 * <content>
 * ```
 *
 * Blocks whose info string does not contain a file path (i.e. only a language
 * or completely empty) are silently skipped.
 *
 * @param text - Raw LLM output containing fenced code blocks.
 * @returns Array of parsed code blocks with language, file path, and content.
 */
export function parseCodeBlocks(text: string): readonly ParsedCodeBlock[] {
  const blocks: ParsedCodeBlock[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    // Info string must have at least two whitespace-separated tokens: lang + path.
    // The path token is the second part (rest of the info string after the first word).
    const openMatch = /^```(\S*)\s+(\S.*?)\s*$/.exec(line);

    if (openMatch !== null) {
      const language = openMatch[1] ?? "";
      const filePath = openMatch[2] ?? "";
      const contentLines: string[] = [];
      i++;

      while (i < lines.length) {
        if (/^```\s*$/.exec(lines[i] ?? "") !== null) {
          break;
        }
        contentLines.push(lines[i] ?? "");
        i++;
      }

      blocks.push({ language, filePath, content: contentLines.join("\n") });
    }

    i++;
  }

  return blocks;
}
