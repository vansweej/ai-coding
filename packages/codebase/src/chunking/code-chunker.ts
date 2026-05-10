import type { CodeChunk } from "../chunk-types";
import { fallbackChunk } from "./fallback-chunker";
import { extractChunks } from "./node-extractors";
import type { ParserPool } from "./parser-pool";

/**
 * Chunk a single source file into {@link CodeChunk}s ready for embedding.
 *
 * Chooses between two strategies:
 *
 * 1. **Tree-sitter** — when a grammar `.wasm` file is installed for the
 *    detected language. Produces semantically meaningful chunks (one per
 *    function / class / declaration).
 *
 * 2. **Fallback** — heading-aware paragraph splitter (see
 *    {@link fallbackChunk}). Used when:
 *    - `language` is `null` (unknown file extension).
 *    - The grammar `.wasm` is not installed.
 *    - The parser returns `null` (cancelled / timed out).
 *    - The grammar loader or WASM runtime throws.
 *    - Tree-sitter produced zero chunks (e.g. empty file or all-error nodes).
 *
 * The fallback ensures every file is still indexed, even without a grammar.
 *
 * @param pool      - Shared {@link ParserPool} (WASM runtime + grammar cache).
 * @param repoId    - Canonical repo identifier (absolute repo root path).
 * @param filePath  - File path relative to the repo root.
 * @param source    - Full source text of the file.
 * @param language  - Grammar name from {@link detectLanguage} (e.g. `"typescript"`),
 *                    or `null` for files with no known grammar.
 * @returns Ordered array of chunks ready for embedding.
 */
export async function chunkFile(
  pool: ParserPool,
  repoId: string,
  filePath: string,
  source: string,
  language: string | null,
): Promise<readonly CodeChunk[]> {
  // Unknown file type or grammar not installed → use fallback immediately.
  if (language === null || !pool.hasGrammar(language)) {
    return fallbackChunk(repoId, filePath, source);
  }

  try {
    const parser = await pool.getParser(language);
    const tree = parser.parse(source);

    if (tree === null) {
      // Parser was cancelled or timed out; degrade gracefully.
      return fallbackChunk(repoId, filePath, source);
    }

    const chunks = extractChunks(tree, source, repoId, filePath, language);

    // If AST walk produced no chunks (empty file, all-error nodes, language
    // entry in CHUNK_NODES has no top-level matches, etc.), the fallback
    // chunker may still produce something useful for retrieval.
    if (chunks.length === 0) {
      return fallbackChunk(repoId, filePath, source);
    }

    return chunks;
  } catch {
    // Grammar load failure, WASM error, or any unexpected runtime error —
    // fall back rather than propagating so the indexer can continue.
    return fallbackChunk(repoId, filePath, source);
  }
}
