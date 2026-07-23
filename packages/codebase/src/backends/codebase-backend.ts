import { realpathSync } from "node:fs";

import type { Embedder } from "@ai-coding/embeddings";

import type { ParserPool } from "../chunking/parser-pool";
import { indexCodebase } from "../indexer/index-codebase";
import type { CodebaseStore } from "../store/codebase-store";
import type { NoIndex, Result } from "./retrieval-result";
import { noIndex, ok } from "./retrieval-result";

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
 * ## Cold vs warm repos
 * The store is the single source of truth for whether a repo has been
 * indexed (see `CodebaseStore.hasRepo`). A repo that has never been indexed
 * ("cold") NEVER triggers an automatic full index — even when `refresh: true`
 * (the default) — because that would silently run a potentially very slow
 * `indexCodebase()` on a first-ever query. Cold repos return `Err(NoIndex)`
 * instead; callers should run `index-codebase` explicitly or fall back to
 * grep/glob.
 *
 * ## Query-time freshness (warm repos)
 * When `refresh: true` (default) and a `repoPath` is provided AND the repo
 * is already warm, the backend calls `indexCodebase()` before searching.
 * Because `indexCodebase` only re-embeds files whose SHA-256 hash changed,
 * this is fast for repos where most files are unchanged — typically < 1 s
 * for small-to-medium codebases.
 *
 * For large repos (poky-scale), set `refresh: false` and rely on the nightly
 * `index-codebase` run.
 *
 * @example
 * const backend = new CodebaseBackend(embedder, store, pool);
 * const result = await backend.search("hash-based staleness check", repoPath);
 * if (result.ok) {
 *   for (const r of result.value) {
 *     console.log(`${r.filePath}:${r.startLine} — ${r.text.slice(0, 80)}`);
 *   }
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
   * A cold repo (never indexed) — or a cold global store when `repoPath` is
   * omitted — always returns `Err(NoIndex)`, regardless of `refresh`. This
   * backend NEVER auto-indexes a cold repo.
   *
   * @param query    - Natural-language or code-fragment query.
   * @param repoPath - When supplied, restrict results to this repo and
   *                   (if warm and `refresh: true`) run an incremental
   *                   refresh first.
   * @param options  - Limit and refresh overrides.
   */
  async search(
    query: string,
    repoPath?: string,
    options: CodebaseSearchOptions = {},
  ): Promise<Result<readonly CodebaseResult[], NoIndex>> {
    const { limit = 10, refresh = true } = options;
    const canonicalRepo = repoPath !== undefined ? realpathSync(repoPath) : undefined;

    if (canonicalRepo !== undefined) {
      const warm = await this.store.hasRepo(canonicalRepo);
      if (!warm) {
        return noIndex(canonicalRepo);
      }

      if (refresh) {
        // Incremental re-index — only changed files are re-embedded.
        // TTL is set high so no freshly indexed rows are purged.
        await indexCodebase(this.embedder, this.store, this.pool, canonicalRepo, {
          ttlDays: 3650,
        });
      } else {
        await this.store.open();
      }
    } else {
      try {
        await this.store.open();
      } catch (err) {
        if (err instanceof Error && err.message.includes("dimensions required")) {
          return noIndex(undefined);
        }
        throw err;
      }
    }

    const { vector } = await this.embedder.embed(query);

    const raw =
      canonicalRepo !== undefined
        ? await this.store.searchInRepo(vector, canonicalRepo, limit)
        : await this.store.search(vector, limit);

    return ok(
      raw.map((r) => ({
        repoId: r.repo_id,
        filePath: r.file_path,
        symbolName: r.symbol_name || null,
        symbolKind: r.symbol_kind || null,
        text: r.text,
        startLine: r.start_line,
        endLine: r.end_line,
        score: 1 - r._distance,
      })),
    );
  }
}
