/**
 * @ai-coding/embeddings
 *
 * Shared embedding abstraction used by both @ai-coding/skills and
 * @ai-coding/codebase. Extracted into its own package to avoid coupling
 * between the skills and codebase packages.
 *
 * Note on naming: this package is named @ai-coding/embeddings (not
 * @ai-coding/shared) because @ai-coding/shared is already a tsconfig path
 * alias pointing to ai-system/shared/event-types.ts. See tsconfig.json at
 * the repo root for the full alias map.
 */

export type { Embedder, EmbeddingResult } from "./embedder-types";
export { OllamaEmbedder, isOllamaReachable, isOllamaModelAvailable } from "./ollama-embedder";
