/**
 * Splits a SKILL.md document into semantically meaningful chunks for indexing.
 *
 * Strategy:
 *   - Split on `##` headings (H2 and deeper) — each section becomes a chunk.
 *   - The H1 title (if present) is prepended to every chunk as context so that
 *     retrieval results are self-contained.
 *   - Chunks that are empty after trimming are dropped.
 *   - Very large sections (> maxChunkChars) are split further on blank lines
 *     so that no single chunk exceeds the token budget of the embedder.
 *
 * The chunker is pure (no I/O) and synchronous for easy testing.
 */

/** A single text chunk ready for embedding. */
export interface SkillChunk {
  /** Skill name (e.g. "programmer") — carried through for metadata. */
  readonly skillName: string;
  /** The chunk text that will be embedded and stored. */
  readonly text: string;
  /**
   * Zero-based index of this chunk within the skill document.
   * Used to reconstruct reading order and as part of the content hash key.
   */
  readonly chunkIndex: number;
}

/** Maximum characters per chunk before paragraph-splitting kicks in. */
const DEFAULT_MAX_CHUNK_CHARS = 3000;

/**
 * Split a single skill's markdown content into indexable chunks.
 *
 * @param skillName  - Name of the skill (e.g. "programmer").
 * @param content    - Full SKILL.md text.
 * @param maxChunkChars - Hard cap on chunk size in characters (default 3000).
 * @returns Ordered array of chunks, ready for embedding.
 */
export function chunkSkill(
  skillName: string,
  content: string,
  maxChunkChars: number = DEFAULT_MAX_CHUNK_CHARS,
): readonly SkillChunk[] {
  // Extract H1 title for context prefix
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const titlePrefix = titleMatch ? `# ${titleMatch[1].trim()}\n\n` : "";

  // Split on H2+ headings — keep the heading with its body
  const sections = content.split(/(?=^##+ )/m).filter((s) => s.trim().length > 0);

  const chunks: SkillChunk[] = [];

  for (const section of sections) {
    // Skip if this section is just the H1 title line with no body
    const withPrefix =
      section.startsWith("#") && !section.startsWith("##")
        ? section // H1 section — use as-is (no double prefix)
        : titlePrefix + section;

    const trimmed = withPrefix.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.length <= maxChunkChars) {
      chunks.push({ skillName, text: trimmed, chunkIndex: chunks.length });
    } else {
      // Split oversized section on blank lines (paragraph boundaries)
      const paragraphs = trimmed.split(/\n{2,}/);
      let current = "";

      for (const para of paragraphs) {
        const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
        if (candidate.length <= maxChunkChars) {
          current = candidate;
        } else {
          if (current.trim().length > 0) {
            chunks.push({ skillName, text: current.trim(), chunkIndex: chunks.length });
          }
          // If a single paragraph exceeds the limit, emit it as its own chunk
          current = para;
        }
      }

      if (current.trim().length > 0) {
        chunks.push({ skillName, text: current.trim(), chunkIndex: chunks.length });
      }
    }
  }

  return chunks;
}
