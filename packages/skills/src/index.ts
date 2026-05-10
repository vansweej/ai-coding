export type {
  ResolvedSkill,
  RetrievalContext,
  SkillBackend,
  WorkspaceType,
} from "./skill-types";
export { resolveSkill } from "./resolve-skill";
export { mergeSkills } from "./merge-skills";
export { ACTION_SKILLS, WORKSPACE_SKILLS, resolveSkillNames } from "./skill-map";
export { detectWorkspaceType } from "./detect-workspace-type";
export { FileBackend } from "./backends/file-backend";

// Phase 2 — vector backend and supporting modules
// Embedder types are re-exported from @ai-coding/embeddings for backward
// compatibility. Consumers should prefer importing directly from that package.
export type { EmbeddingResult, Embedder } from "@ai-coding/embeddings";
export { OllamaEmbedder, isOllamaReachable } from "@ai-coding/embeddings";
export type { SkillChunk } from "./chunking/markdown-chunker";
export { chunkSkill } from "./chunking/markdown-chunker";
export type { SkillRow, SkillSearchResult } from "./store/lance-store";
export { LanceStore, DEFAULT_DB_PATH } from "./store/lance-store";
export type { SkillIndexMeta, IndexResult } from "./indexer/index-skills";
export { indexSkills } from "./indexer/index-skills";
export { VectorBackend } from "./backends/vector-backend";
export type { CreateBackendOptions } from "./backends/create-backend";
export { createBestBackend } from "./backends/create-backend";
