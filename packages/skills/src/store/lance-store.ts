import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";

import type { SkillChunk } from "../chunking/markdown-chunker";
import type { EmbeddingResult } from "../embeddings/embedder-types";

/** Default LanceDB path — overridable via AI_CODING_SKILLS_DB env var. */
export const DEFAULT_DB_PATH = join(homedir(), ".local", "share", "ai-coding", "skills.lance");

/** Name of the LanceDB table that stores skill chunks. */
const TABLE_NAME = "skills";

/** A row as stored in LanceDB. */
export interface SkillRow {
  readonly vector: Float32Array;
  readonly text: string;
  readonly skill_name: string;
  readonly chunk_index: number;
  readonly content_hash: string;
}

/** A row returned from a vector search, with distance appended by LanceDB. */
export interface SkillSearchResult extends SkillRow {
  readonly _distance: number;
}

/**
 * Wraps a LanceDB table for skill chunk storage and retrieval.
 *
 * The store is opened lazily on first use. Call `open()` explicitly if you
 * want to pre-warm the connection (e.g. in the indexer CLI).
 *
 * Indexing strategy: delete all existing rows for a skill, then bulk-insert
 * the new chunks. This is simpler and more reliable than mergeInsert for our
 * use-case (skills are small, full re-index is fast).
 *
 * @example
 * const store = new LanceStore("/tmp/my-skills.lance");
 * await store.upsertSkill("programmer", chunks, embeddings);
 * const results = await store.search(queryVec, 5);
 */
export class LanceStore {
  readonly dbPath: string;
  private _table: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["openTable"]>> | undefined;
  private _dimensions: number | undefined;

  constructor(dbPath: string = process.env.AI_CODING_SKILLS_DB ?? DEFAULT_DB_PATH) {
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
        throw new Error("LanceStore.open(): dimensions required when creating a new table");
      }
      this._dimensions = dimensions;
      const schema = buildSchema(dimensions);
      this._table = await db.createTable(TABLE_NAME, [], { schema });
    }
  }

  /**
   * Replace all chunks for a skill with new embeddings.
   *
   * Deletes existing rows for `skillName`, then inserts the new chunks.
   * The `chunks` and `embeddings` arrays must have the same length.
   *
   * @param skillName  - Skill name used as the delete key.
   * @param chunks     - Ordered chunks from `chunkSkill()`.
   * @param embeddings - Embedding for each chunk, in the same order.
   */
  async upsertSkill(
    skillName: string,
    chunks: readonly SkillChunk[],
    embeddings: readonly EmbeddingResult[],
  ): Promise<void> {
    if (chunks.length !== embeddings.length) {
      throw new Error(
        `upsertSkill: chunks.length (${chunks.length}) !== embeddings.length (${embeddings.length})`,
      );
    }

    const table = await this.table();

    // Delete existing rows for this skill
    await table.delete(`skill_name = '${skillName}'`);

    if (chunks.length === 0) return;

    const rows: SkillRow[] = chunks.map((chunk, i) => {
      const embedding = embeddings[i];
      if (embedding === undefined) {
        throw new Error(`Missing embedding at index ${i}`);
      }
      return {
        vector: embedding.vector,
        text: chunk.text,
        skill_name: chunk.skillName,
        chunk_index: chunk.chunkIndex,
        content_hash: hashChunk(chunk),
      };
    });

    await table.add(rows as unknown as Record<string, unknown>[]);
  }

  /**
   * Search for the top-k most similar chunks to the query vector.
   *
   * @param queryVector - The query embedding vector.
   * @param limit       - Maximum number of results to return.
   * @returns Results ordered by ascending distance (most similar first).
   */
  async search(queryVector: Float32Array, limit: number): Promise<readonly SkillSearchResult[]> {
    const table = await this.table();
    const raw = await table.vectorSearch(Array.from(queryVector)).limit(limit).toArray();
    return raw as unknown as SkillSearchResult[];
  }

  /**
   * Return the number of rows currently in the table.
   * Useful for health checks and tests.
   */
  async countRows(): Promise<number> {
    const table = await this.table();
    return table.countRows();
  }

  /**
   * Delete all rows for a given skill.
   * No-op if the skill has no rows.
   */
  async deleteSkill(skillName: string): Promise<void> {
    const table = await this.table();
    await table.delete(`skill_name = '${skillName}'`);
  }

  private async table(): Promise<NonNullable<typeof this._table>> {
    if (this._table === undefined) {
      throw new Error("LanceStore not opened. Call open() before using the store.");
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
    new Field("skill_name", new Utf8(), false),
    new Field("chunk_index", new Int32(), false),
    new Field("content_hash", new Utf8(), false),
  ]);
}

/**
 * Deterministic hash for a chunk — used as the content_hash column value.
 * Uses a simple djb2-style hash over the skill name + chunk index + text.
 * Not cryptographically secure; collision resistance is sufficient for our use.
 */
function hashChunk(chunk: SkillChunk): string {
  let h = 5381;
  const str = `${chunk.skillName}:${chunk.chunkIndex}:${chunk.text}`;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
