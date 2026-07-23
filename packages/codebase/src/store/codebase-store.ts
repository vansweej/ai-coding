import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";

import type { EmbeddingResult } from "@ai-coding/embeddings";

import type { CodeChunk } from "../chunk-types";

/**
 * Default LanceDB path for the codebase table.
 * Overridable via the `AI_CODING_CODEBASE_DB` environment variable.
 */
export const DEFAULT_CODEBASE_DB_PATH = join(
  homedir(),
  ".local",
  "share",
  "ai-coding",
  "codebase.lance",
);

/** Name of the LanceDB table that stores codebase chunks. */
const TABLE_NAME = "codebase";

/** Default TTL in days — rows older than this are purged automatically. */
export const DEFAULT_TTL_DAYS = 30;

/** A row as stored in LanceDB. */
export interface CodebaseRow {
  readonly vector: Float32Array;
  readonly text: string;
  readonly repo_id: string;
  readonly file_path: string;
  readonly symbol_name: string;
  readonly symbol_kind: string;
  readonly chunk_index: number;
  readonly start_line: number;
  readonly end_line: number;
  readonly content_hash: string;
  /** ISO-8601 timestamp of when this row was last indexed. */
  readonly indexed_at: string;
}

/** A row returned from a vector search, with distance appended by LanceDB. */
export interface CodebaseSearchResult extends CodebaseRow {
  readonly _distance: number;
}

/**
 * Wraps a LanceDB table for codebase chunk storage and retrieval.
 *
 * The store is opened lazily on first use. Call `open()` explicitly if you
 * want to pre-warm the connection (e.g. in the indexer CLI).
 *
 * Indexing strategy: delete all rows for a (repo_id, file_path) pair, then
 * bulk-insert the new chunks. This is simpler and more reliable than
 * mergeInsert for per-file updates.
 *
 * @example
 * const store = new CodebaseStore();
 * await store.open(768);
 * await store.upsertFile("/repo/path", "src/main.ts", chunks, embeddings);
 * const results = await store.search(queryVec, 10);
 */
export class CodebaseStore {
  readonly dbPath: string;
  private _table: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["openTable"]>> | undefined;

  constructor(dbPath: string = process.env.AI_CODING_CODEBASE_DB ?? DEFAULT_CODEBASE_DB_PATH) {
    this.dbPath = dbPath;
  }

  /**
   * Open (or create) the LanceDB table.
   * Safe to call multiple times — returns the cached table on subsequent calls.
   *
   * @param dimensions - Embedding vector dimensions. Required only on first call
   *                     when the table does not yet exist.
   */
  async open(dimensions?: number): Promise<void> {
    if (this._table !== undefined) return;

    const db = await connect(this.dbPath);
    const tableNames = await db.tableNames();

    if (tableNames.includes(TABLE_NAME)) {
      this._table = await db.openTable(TABLE_NAME);
    } else {
      if (dimensions === undefined) {
        throw new Error("CodebaseStore.open(): dimensions required when creating a new table");
      }
      const schema = buildSchema(dimensions);
      this._table = await db.createTable(TABLE_NAME, [], { schema });
    }
  }

  /**
   * Replace all chunks for a (repoId, filePath) pair with new embeddings.
   *
   * Deletes existing rows for the file, then inserts the new chunks.
   * `chunks` and `embeddings` must have the same length.
   *
   * @param repoId     - Canonical repo identifier (absolute repo root path).
   * @param filePath   - File path relative to the repo root.
   * @param chunks     - Ordered chunks from the code or fallback chunker.
   * @param embeddings - Embedding for each chunk, in the same order.
   */
  async upsertFile(
    repoId: string,
    filePath: string,
    chunks: readonly CodeChunk[],
    embeddings: readonly EmbeddingResult[],
  ): Promise<void> {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `upsertFile: chunks.length (${chunks.length}) !== embeddings.length (${embeddings.length})`,
      );
    }

    const table = await this.table();

    // Delete existing rows for this file
    await table.delete(`repo_id = '${escapeStr(repoId)}' AND file_path = '${escapeStr(filePath)}'`);

    if (chunks.length === 0) return;

    const indexedAt = new Date().toISOString();
    const rows: CodebaseRow[] = chunks.map((chunk, i) => {
      const embedding = embeddings[i];
      if (embedding === undefined) {
        throw new Error(`Missing embedding at index ${i}`);
      }
      return {
        vector: embedding.vector,
        text: chunk.text,
        repo_id: chunk.repoId,
        file_path: chunk.filePath,
        symbol_name: chunk.symbolName ?? "",
        symbol_kind: chunk.symbolKind ?? "",
        chunk_index: chunk.chunkIndex,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        content_hash: hashChunk(chunk),
        indexed_at: indexedAt,
      };
    });

    await table.add(rows as unknown as Record<string, unknown>[]);
  }

  /**
   * Delete all chunks for a specific file within a repo.
   * No-op if the file has no rows.
   */
  async deleteFile(repoId: string, filePath: string): Promise<void> {
    const table = await this.table();
    await table.delete(`repo_id = '${escapeStr(repoId)}' AND file_path = '${escapeStr(filePath)}'`);
  }

  /**
   * Delete all chunks for an entire repository.
   * No-op if the repo has no rows.
   */
  async deleteRepo(repoId: string): Promise<void> {
    const table = await this.table();
    await table.delete(`repo_id = '${escapeStr(repoId)}'`);
  }

  /**
   * Return distinct file paths for one repository whose rows were indexed
   * before `cutoffDate`.
   *
   * TTL staleness is intentionally scoped to the repo being indexed so an
   * index run for repo B cannot surface stale rows from repo A.
   *
   * @param repoId     - Canonical repo identifier to scope the query to.
   * @param cutoffDate - ISO-8601 date string. Rows with `indexed_at` before
   *                     this date are considered stale.
   * @returns Distinct relative file paths that are stale.
   */
  async queryStalePaths(repoId: string, cutoffDate: string): Promise<readonly string[]> {
    const table = await this.table();
    const rows = (await table
      .query()
      .where(`repo_id = '${escapeStr(repoId)}' AND indexed_at < '${escapeStr(cutoffDate)}'`)
      .select(["file_path"])
      .toArray()) as Array<{ file_path: string }>;
    const unique = new Set(rows.map((r) => r.file_path));
    return Array.from(unique);
  }

  /**
   * Delete all rows for a set of file paths within one repository.
   *
   * Batches the delete into chunks of ~500 paths to keep the generated
   * filter expression within a reasonable size. No-op if `paths` is empty.
   *
   * @param repoId - Canonical repo identifier to scope the delete to.
   * @param paths  - Relative file paths to delete.
   */
  async deleteFilesByPaths(repoId: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;

    const table = await this.table();
    const BATCH_SIZE = 500;

    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const batch = paths.slice(i, i + BATCH_SIZE);
      const inList = batch.map((p) => `'${escapeStr(p)}'`).join(", ");
      await table.delete(`repo_id = '${escapeStr(repoId)}' AND file_path IN (${inList})`);
    }
  }

  /**
   * Refresh `indexed_at` for all currently stored rows in a repository.
   *
   * Called after indexing and deleted-file cleanup so hash-skipped files remain
   * fresh for TTL purposes without issuing one update per skipped file.
   *
   * @param repoId    - Canonical repo identifier whose rows should be touched.
   * @param indexedAt - ISO-8601 timestamp to write to `indexed_at`.
   */
  async touchRepo(repoId: string, indexedAt: string): Promise<void> {
    const table = await this.table();
    await table.update({
      where: `repo_id = '${escapeStr(repoId)}'`,
      values: { indexed_at: indexedAt },
    });
  }

  /**
   * Search for the top-k most similar chunks to the query vector.
   *
   * @param queryVector - The query embedding vector.
   * @param limit       - Maximum number of results to return (default 10).
   * @returns Results ordered by ascending distance (most similar first).
   */
  async search(queryVector: Float32Array, limit = 10): Promise<readonly CodebaseSearchResult[]> {
    const table = await this.table();
    const raw = await table.vectorSearch(Array.from(queryVector)).limit(limit).toArray();
    return raw as unknown as CodebaseSearchResult[];
  }

  /**
   * Search within a specific repository only.
   *
   * @param queryVector - The query embedding vector.
   * @param repoId      - Restrict results to this repo.
   * @param limit       - Maximum number of results to return (default 10).
   */
  async searchInRepo(
    queryVector: Float32Array,
    repoId: string,
    limit = 10,
  ): Promise<readonly CodebaseSearchResult[]> {
    const table = await this.table();
    const raw = await table
      .vectorSearch(Array.from(queryVector))
      .where(`repo_id = '${escapeStr(repoId)}'`)
      .limit(limit)
      .toArray();
    return raw as unknown as CodebaseSearchResult[];
  }

  /**
   * Check whether a repo has ever been indexed.
   *
   * This is the SINGLE SOURCE OF TRUTH for "is this repo indexed" — meta.json
   * (used elsewhere for incremental hash checks) can drift from the actual
   * LanceDB table contents via TTL purge, so callers that need to know
   * whether a repo is cold must query the store directly, not meta.json.
   *
   * Distinguishes "table does not exist yet" (cold DB, returns `false`) from
   * genuine I/O errors (re-thrown) by narrowly matching the specific
   * "dimensions required" error thrown by `open()` for a missing table.
   *
   * @param repoId - Canonical repo identifier to check.
   * @returns `true` if at least one row exists for `repoId`.
   */
  async hasRepo(repoId: string): Promise<boolean> {
    try {
      await this.open();
    } catch (err) {
      if (err instanceof Error && err.message.includes("dimensions required")) {
        return false;
      }
      throw err;
    }

    const table = await this.table();
    const rows = (await table
      .query()
      .where(`repo_id = '${escapeStr(repoId)}'`)
      .select(["repo_id"])
      .limit(1)
      .toArray()) as Array<{ repo_id: string }>;
    return rows.length > 0;
  }

  /**
   * Return all distinct repo_id values currently in the table.
   * Used by the purge step to detect dead repos.
   */
  async listRepoIds(): Promise<readonly string[]> {
    const table = await this.table();
    const rows = (await table.query().select(["repo_id"]).toArray()) as Array<{
      repo_id: string;
    }>;
    const unique = new Set(rows.map((r) => r.repo_id));
    return Array.from(unique);
  }

  /**
   * Return the number of rows currently in the table.
   * Useful for health checks and tests.
   */
  async countRows(): Promise<number> {
    const table = await this.table();
    return table.countRows();
  }

  private async table(): Promise<NonNullable<typeof this._table>> {
    if (this._table === undefined) {
      throw new Error("CodebaseStore not opened. Call open() before using the store.");
    }
    return this._table;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function buildSchema(dimensions: number): Schema {
  return new Schema([
    new Field(
      "vector",
      new FixedSizeList(dimensions, new Field("item", new Float32(), true)),
      false,
    ),
    new Field("text", new Utf8(), false),
    new Field("repo_id", new Utf8(), false),
    new Field("file_path", new Utf8(), false),
    new Field("symbol_name", new Utf8(), false),
    new Field("symbol_kind", new Utf8(), false),
    new Field("chunk_index", new Int32(), false),
    new Field("start_line", new Int32(), false),
    new Field("end_line", new Int32(), false),
    new Field("content_hash", new Utf8(), false),
    new Field("indexed_at", new Utf8(), false),
  ]);
}

/**
 * Deterministic djb2-style hash for a chunk.
 * Collision resistance is sufficient for content-hash staleness detection.
 */
function hashChunk(chunk: CodeChunk): string {
  let h = 5381;
  const str = `${chunk.repoId}:${chunk.filePath}:${chunk.chunkIndex}:${chunk.text}`;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Escape a string for embedding in a LanceDB filter expression.
 * LanceDB uses SQL-like filter syntax; single quotes must be escaped.
 */
function escapeStr(value: string): string {
  return value.replace(/'/g, "''");
}
