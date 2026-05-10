/**
 * @ai-coding/codebase
 *
 * Codebase RAG indexer — indexes source files into LanceDB using tree-sitter
 * WASM-based code chunking and Ollama embeddings. Enables semantic code
 * retrieval across multiple repositories without re-reading files on every
 * agent session.
 *
 * See docs/codebase-indexer.md for full architecture and usage documentation.
 */

// Core types
export type { CodeChunk } from "./chunk-types";

// Discovery
export { detectLanguage } from "./discovery/detect-language";
export { discoverFiles, resolveFilePath } from "./discovery/discover-files";

// Chunking
export { fallbackChunk } from "./chunking/fallback-chunker";

// Store
export type { CodebaseRow, CodebaseSearchResult } from "./store/codebase-store";
export {
  CodebaseStore,
  DEFAULT_CODEBASE_DB_PATH,
  DEFAULT_TTL_DAYS,
} from "./store/codebase-store";
