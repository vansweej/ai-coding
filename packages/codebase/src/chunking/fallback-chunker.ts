import type { CodeChunk } from "../chunk-types";

/** Maximum characters per chunk before sub-splitting on blank lines. */
const DEFAULT_MAX_CHUNK_CHARS = 3000;

/**
 * Fallback chunker for files with no tree-sitter grammar.
 *
 * Strategy mirrors the markdown-chunker used for skill documents:
 *   - Split on heading-like lines (`#`, `//`, `--`, `==`, `;;`) and blank lines.
 *   - Heading lines are split-points that also act as context prefixes.
 *   - Each section becomes one chunk; oversized sections are sub-split on
 *     blank lines so no chunk exceeds `maxChunkChars`.
 *   - Empty sections are dropped.
 *
 * `symbolName` and `symbolKind` are always null for fallback chunks — the
 * chunker has no AST knowledge of the file.
 *
 * Suitable for: `.nix`, `.toml`, `.yaml`, `.md`, `.json`, shell scripts, and
 * any other file type without a tree-sitter grammar.
 *
 * @param repoId   - Canonical repo identifier (absolute repo root path).
 * @param filePath - File path relative to the repo root.
 * @param content  - Full file content as a string.
 * @param maxChunkChars - Hard cap on chunk size in characters (default 3000).
 * @returns Ordered array of chunks ready for embedding.
 */
export function fallbackChunk(
  repoId: string,
  filePath: string,
  content: string,
  maxChunkChars: number = DEFAULT_MAX_CHUNK_CHARS,
): readonly CodeChunk[] {
  if (content.trim().length === 0) return [];

  const lines = content.split("\n");
  const prefix = `# file: ${filePath}\n\n`;

  // Split into sections on heading-like lines and blank lines
  const sections = splitIntoSections(lines);

  const chunks: CodeChunk[] = [];

  for (const section of sections) {
    const text = (prefix + section.text).trim();
    if (text.length === 0) continue;

    if (text.length <= maxChunkChars) {
      chunks.push(
        makeChunk(repoId, filePath, text, chunks.length, section.startLine, section.endLine),
      );
    } else {
      // Sub-split oversized sections on blank lines
      const paragraphs = text.split(/\n{2,}/);
      let current = "";
      let currentStart = section.startLine;

      for (const para of paragraphs) {
        const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
        if (candidate.length <= maxChunkChars) {
          current = candidate;
        } else {
          if (current.trim().length > 0) {
            const paraLines = current.split("\n").length;
            chunks.push(
              makeChunk(
                repoId,
                filePath,
                current.trim(),
                chunks.length,
                currentStart,
                currentStart + paraLines - 1,
              ),
            );
            currentStart += paraLines;
          }
          current = para;
        }
      }

      if (current.trim().length > 0) {
        const paraLines = current.split("\n").length;
        chunks.push(
          makeChunk(
            repoId,
            filePath,
            current.trim(),
            chunks.length,
            currentStart,
            currentStart + paraLines - 1,
          ),
        );
      }
    }
  }

  return chunks;
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface Section {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Split file lines into logical sections on heading-like lines.
 * Heading-like lines include Markdown headings (`#`), comment section
 * headers (`//---`, `##`, `;;`) and blank-line-separated blocks.
 */
function splitIntoSections(lines: string[]): Section[] {
  const HEADING_PATTERN = /^(#{1,6} |\/\/[─=\-─]{3,}|;;[─=\-]{3,}|--[─=\-]{3,})/;
  const sections: Section[] = [];
  let current: string[] = [];
  let startLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;

    if (HEADING_PATTERN.test(line) && current.length > 0) {
      // Emit accumulated section
      sections.push({
        text: current.join("\n"),
        startLine,
        endLine: lineNumber - 1,
      });
      current = [line];
      startLine = lineNumber;
    } else {
      current.push(line);
    }
  }

  if (current.length > 0 && current.some((l) => l.trim().length > 0)) {
    sections.push({
      text: current.join("\n"),
      startLine,
      endLine: lines.length,
    });
  }

  return sections;
}

function makeChunk(
  repoId: string,
  filePath: string,
  text: string,
  chunkIndex: number,
  startLine: number,
  endLine: number,
): CodeChunk {
  return {
    repoId,
    filePath,
    symbolName: null,
    symbolKind: null,
    text,
    chunkIndex,
    startLine,
    endLine,
  };
}
