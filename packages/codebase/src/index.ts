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
export { IGNORE_FILE, KEEP_FILE, loadMatcher, readPatterns } from "./discovery/pattern-config";

// Chunking
export { fallbackChunk } from "./chunking/fallback-chunker";
export { chunkFile } from "./chunking/code-chunker";
export { extractChunks } from "./chunking/node-extractors";
export { ParserPool, DEFAULT_GRAMMARS_DIR } from "./chunking/parser-pool";

// Indexer
export type { IndexCodebaseOptions, IndexCodebaseResult } from "./indexer/index-codebase";
export { indexCodebase, TotalExclusionError } from "./indexer/index-codebase";
export type { PurgeResult } from "./indexer/purge";
export { purgeStale, purgeDeadRepos, purgeRepo, runPostIndexPurge } from "./indexer/purge";

// Retrieval backend
export type { CodebaseResult, CodebaseSearchOptions } from "./backends/codebase-backend";
export { CodebaseBackend } from "./backends/codebase-backend";

export {
  CodebaseStore,
  DEFAULT_CODEBASE_DB_PATH,
  DEFAULT_TTL_DAYS,
} from "./store/codebase-store";
