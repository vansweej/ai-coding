import { homedir } from "node:os";
import { join } from "node:path";

import { OllamaEmbedder, isOllamaReachable } from "@ai-coding/embeddings";
import type { SkillBackend } from "../skill-types";
import { DEFAULT_DB_PATH, LanceStore } from "../store/lance-store";
import { FileBackend } from "./file-backend";
import { VectorBackend } from "./vector-backend";

/** Default skill root — same as FileBackend. */
const DEFAULT_SKILL_ROOT = join(homedir(), ".config", "opencode", "skill");

/**
 * Options for `createBestBackend`.
 * All fields are optional — defaults are production-ready.
 */
export interface CreateBackendOptions {
  /**
   * Absolute path to the skill root directory.
   * Defaults to `~/.config/opencode/skill`.
   */
  readonly skillRoot?: string;
  /**
   * Absolute path to the LanceDB directory.
   * Defaults to `~/.local/share/ai-coding/skills.lance`.
   * Can also be set via the `AI_CODING_SKILLS_DB` environment variable.
   */
  readonly dbPath?: string;
  /**
   * Ollama model name to use for embeddings.
   * Defaults to `"nomic-embed-text"`.
   */
  readonly ollamaModel?: string;
  /**
   * Ollama base URL.
   * Defaults to `"http://localhost:11434"`.
   */
  readonly ollamaUrl?: string;
  /**
   * Token budget for the vector backend.
   * Defaults to 2000 tokens (~8000 chars).
   */
  readonly tokenBudget?: number;
}

/**
 * Auto-selects the best available skill backend.
 *
 * Selection logic (in priority order):
 *   1. **VectorBackend** — when Ollama is reachable AND the LanceDB file exists.
 *      Provides semantic retrieval with relevance scores.
 *   2. **FileBackend** — fallback when Ollama is unavailable or the DB has not
 *      been built yet. Provides deterministic action-based routing.
 *
 * This function never throws — it always returns a working backend.
 *
 * @example
 * // In pipeline CLI (load-config.ts):
 * const backend = await createBestBackend();
 * const step = createSkillResolverStep("resolve-skills", backend);
 */
export async function createBestBackend(options: CreateBackendOptions = {}): Promise<SkillBackend> {
  const {
    skillRoot = DEFAULT_SKILL_ROOT,
    dbPath = process.env.AI_CODING_SKILLS_DB ?? DEFAULT_DB_PATH,
    ollamaModel = "nomic-embed-text",
    ollamaUrl,
    tokenBudget,
  } = options;

  const [ollamaReachable, dbExists] = await Promise.all([
    isOllamaReachable(ollamaUrl),
    lanceDbExists(dbPath),
  ]);

  if (ollamaReachable && dbExists) {
    const embedder = new OllamaEmbedder(ollamaModel, ollamaUrl);
    const store = new LanceStore(dbPath);
    // Open without dimensions — table already exists
    await store.open();
    return new VectorBackend(embedder, store, tokenBudget);
  }

  return new FileBackend(skillRoot);
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function lanceDbExists(dbPath: string): Promise<boolean> {
  // LanceDB creates a sub-directory per table. The skills table is named
  // "skills", so its version manifests live at <dbPath>/skills/_versions/.
  // When the LanceDB connection path itself ends in "skills.lance", the
  // table directory is <dbPath>/skills/_versions/ (standard layout).
  // We also handle the edge-case where connect() nests the path (e.g. when
  // the dbPath basename matches the table name).
  const { readdir } = await import("node:fs/promises");

  // Try both candidate layouts — return true as soon as one has entries
  for (const candidate of [
    join(dbPath, "skills", "_versions"),
    join(dbPath, "skills.lance", "_versions"),
  ]) {
    try {
      const entries = await readdir(candidate);
      if (entries.length > 0) return true;
    } catch {
      // directory does not exist — try next candidate
    }
  }
  return false;
}
