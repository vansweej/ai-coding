import type { Embedder } from "@ai-coding/embeddings";

import type { ParserPool } from "../chunking/parser-pool";
import { indexCodebase } from "../indexer/index-codebase";
import type { CodebaseStore } from "../store/codebase-store";

// ── public types ──────────────────────────────────────────────────────────────

/** A single result from a codebase semantic search. */
export interface CodebaseResult {
  /** Canonical repo identifier (the `repoPath` used during indexing). */
  readonly repoId: string;
  /** File path relative to the repo root. */
  readonly filePath: string;
  /** Symbol name (function, class, etc.) or null for fallback-chunked content. */
  readonly symbolName: string | null;
  /** AST node type string or null for fallback-chunked content. */
  readonly symbolKind: string | null;
  /** Chunk text including the `# file: …` context prefix. */
  readonly text: string;
  /** 1-based start line in the source file. */
  readonly startLine: number;
  /** 1-based end line in the source file (inclusive). */
  readonly endLine: number;
  /**
   * Similarity score in `[−∞, 1]` — higher is more similar.
   * Computed as `1 − L2_distance` from the LanceDB vector search.
   */
  readonly score: number;
}

/** Options for {@link CodebaseBackend.search}. */
export interface CodebaseSearchOptions {
  /** Maximum number of results to return. Default: 10. */
  readonly limit?: number;
  /**
   * When `true` (default), run an incremental re-index of `repoPath` before
   * searching so results reflect uncommitted changes.
   * Set to `false` for faster queries when freshness is not critical (e.g.
   * large repos where the nightly `index-codebase` run is the primary mechanism).
   */
  readonly refresh?: boolean;
}

// ── backend ───────────────────────────────────────────────────────────────────

/**
 * High-level retrieval backend that combines query-time incremental re-indexing
 * with LanceDB vector search.
 *
 * ## Query-time freshness
 * When `refresh: true` (default) and a `repoPath` is provided, the backend
 * calls `indexCodebase()` before searching. Because `indexCodebase` only
 * re-embeds files whose SHA-256 hash changed, this is fast for repos where
 * most files are unchanged — typically < 1 s for small-to-medium codebases.
 *
 * For large repos (poky-scale), set `refresh: false` and rely on the nightly
 * `index-codebase` run.
 *
 * @example
 * const backend = new CodebaseBackend(embedder, store, pool);
 * const results = await backend.search("hash-based staleness check", repoPath);
 * for (const r of results) {
 *   console.log(`${r.filePath}:${r.startLine} — ${r.text.slice(0, 80)}`);
 * }
 */
export class CodebaseBackend {
  constructor(
    private readonly embedder: Embedder,
    private readonly store: CodebaseStore,
    private readonly pool: ParserPool,
  ) {}

  /**
   * Search the codebase index for chunks that match `query`.
   *
   * @param query    - Natural-language or code-fragment search query.
   * @param repoPath - When supplied, restrict results to this repo and
   *                   (if `refresh: true`) run an incremental refresh first.
   * @param options  - Limit and refresh overrides.
   */
  async search(
    query: string,
    repoPath?: string,
    options: CodebaseSearchOptions = {},
  ): Promise<readonly CodebaseResult[]> {
    const { limit = 10, refresh = true } = options;

    if (refresh && repoPath !== undefined) {
      // Incremental re-index — only changed files are re-embedded.
      // TTL is set high so no freshly indexed rows are purged.
      await indexCodebase(this.embedder, this.store, this.pool, repoPath, {
        ttlDays: 3650,
      });
    } else {
      // Ensure the store table is open.  Throws if it does not yet exist,
      // which is the correct behaviour when no indexing has been run.
      await this.store.open();
    }

    const { vector } = await this.embedder.embed(query);

    const raw =
      repoPath !== undefined
        ? await this.store.searchInRepo(vector, repoPath, limit)
        : await this.store.search(vector, limit);

    return raw.map((r) => ({
      repoId: r.repo_id,
      filePath: r.file_path,
      symbolName: r.symbol_name || null,
      symbolKind: r.symbol_kind || null,
      text: r.text,
      startLine: r.start_line,
      endLine: r.end_line,
      score: 1 - r._distance,
    }));
  }
}
