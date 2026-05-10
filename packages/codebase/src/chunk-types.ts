/**
 * Core types for the codebase chunking and indexing pipeline.
 *
 * A CodeChunk is the fundamental unit stored in LanceDB. Each chunk
 * represents a semantically meaningful portion of a source file — a function,
 * class, import block, or paragraph-split fallback section.
 */

/**
 * A single indexed code chunk ready for embedding and storage.
 *
 * All line numbers are 1-based and inclusive. `symbolName` and `symbolKind`
 * are null for fallback-chunked files (no tree-sitter grammar available).
 */
export interface CodeChunk {
  /** Canonical repo identifier — absolute path to the repo root. */
  readonly repoId: string;
  /** File path relative to the repo root. */
  readonly filePath: string;
  /** Name of the symbol (function, class, etc.) or null for non-symbol chunks. */
  readonly symbolName: string | null;
  /**
   * Kind of AST node (e.g. "function_declaration", "class_declaration")
   * or null for fallback-chunked content.
   */
  readonly symbolKind: string | null;
  /** The chunk text that will be embedded. Includes a context prefix. */
  readonly text: string;
  /** Zero-based index of this chunk within the file. */
  readonly chunkIndex: number;
  /** 1-based start line in the source file. */
  readonly startLine: number;
  /** 1-based end line in the source file (inclusive). */
  readonly endLine: number;
}
