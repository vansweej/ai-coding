import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingResult } from "@ai-coding/embeddings";

import type { CodeChunk } from "../chunk-types";
import { CodebaseStore } from "./codebase-store";

// ── helpers ───────────────────────────────────────────────────────────────────

const DIMS = 4;
const REPO_ID = "/home/dev/myrepo";

function makeVector(seed: number): Float32Array {
  return new Float32Array([seed, seed + 0.1, seed + 0.2, seed + 0.3]);
}

function makeEmbedding(seed: number): EmbeddingResult {
  return { vector: makeVector(seed) };
}

function makeChunk(
  filePath: string,
  chunkIndex: number,
  overrides: Partial<CodeChunk> = {},
): CodeChunk {
  return {
    repoId: REPO_ID,
    filePath,
    symbolName: "myFunc",
    symbolKind: "function_declaration",
    text: `chunk ${chunkIndex} of ${filePath}`,
    chunkIndex,
    startLine: chunkIndex * 10 + 1,
    endLine: chunkIndex * 10 + 9,
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("CodebaseStore", () => {
  let tmpDir: string;
  let store: CodebaseStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "codebase-store-test-"));
    store = new CodebaseStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── open ────────────────────────────────────────────────────────────────────

  it("open() creates a new table when none exists", async () => {
    await store.open(DIMS);
    expect(await store.countRows()).toBe(0);
  });

  it("open() is idempotent — calling twice does not throw", async () => {
    await store.open(DIMS);
    await store.open(DIMS);
    expect(await store.countRows()).toBe(0);
  });

  it("open() throws when called without dimensions on a new table", async () => {
    await expect(store.open()).rejects.toThrow("dimensions required");
  });

  it("table() throws if store is not opened", async () => {
    await expect(store.countRows()).rejects.toThrow("not opened");
  });

  // ── upsertFile ──────────────────────────────────────────────────────────────

  it("upsertFile() inserts chunks and countRows reflects the count", async () => {
    await store.open(DIMS);
    const chunks = [makeChunk("src/a.ts", 0), makeChunk("src/a.ts", 1)];
    const embeddings = [makeEmbedding(1), makeEmbedding(2)];
    await store.upsertFile(REPO_ID, "src/a.ts", chunks, embeddings);
    expect(await store.countRows()).toBe(2);
  });

  it("upsertFile() replaces existing chunks for the same file", async () => {
    await store.open(DIMS);
    const chunks1 = [makeChunk("src/a.ts", 0), makeChunk("src/a.ts", 1)];
    await store.upsertFile(REPO_ID, "src/a.ts", chunks1, [makeEmbedding(1), makeEmbedding(2)]);

    // Re-index with only 1 chunk
    const chunks2 = [makeChunk("src/a.ts", 0)];
    await store.upsertFile(REPO_ID, "src/a.ts", chunks2, [makeEmbedding(3)]);

    expect(await store.countRows()).toBe(1);
  });

  it("upsertFile() is a no-op when chunks array is empty", async () => {
    await store.open(DIMS);
    await store.upsertFile(REPO_ID, "src/empty.ts", [], []);
    expect(await store.countRows()).toBe(0);
  });

  it("upsertFile() throws when chunks and embeddings lengths differ", async () => {
    await store.open(DIMS);
    const chunks = [makeChunk("src/a.ts", 0)];
    await expect(store.upsertFile(REPO_ID, "src/a.ts", chunks, [])).rejects.toThrow(
      "chunks.length",
    );
  });

  it("upsertFile() does not affect other files in the same repo", async () => {
    await store.open(DIMS);
    await store.upsertFile(REPO_ID, "src/a.ts", [makeChunk("src/a.ts", 0)], [makeEmbedding(1)]);
    await store.upsertFile(REPO_ID, "src/b.ts", [makeChunk("src/b.ts", 0)], [makeEmbedding(2)]);
    await store.upsertFile(REPO_ID, "src/a.ts", [makeChunk("src/a.ts", 0)], [makeEmbedding(3)]);
    expect(await store.countRows()).toBe(2);
  });

  // ── deleteFile ──────────────────────────────────────────────────────────────

  it("deleteFile() removes all chunks for a file", async () => {
    await store.open(DIMS);
    await store.upsertFile(REPO_ID, "src/a.ts", [makeChunk("src/a.ts", 0)], [makeEmbedding(1)]);
    await store.deleteFile(REPO_ID, "src/a.ts");
    expect(await store.countRows()).toBe(0);
  });

  it("deleteFile() is a no-op for a non-existent file", async () => {
    await store.open(DIMS);
    await expect(store.deleteFile(REPO_ID, "src/nonexistent.ts")).resolves.toBeUndefined();
  });

  // ── deleteRepo ──────────────────────────────────────────────────────────────

  it("deleteRepo() removes all chunks for the entire repo", async () => {
    await store.open(DIMS);
    await store.upsertFile(REPO_ID, "src/a.ts", [makeChunk("src/a.ts", 0)], [makeEmbedding(1)]);
    await store.upsertFile(REPO_ID, "src/b.ts", [makeChunk("src/b.ts", 0)], [makeEmbedding(2)]);
    await store.deleteRepo(REPO_ID);
    expect(await store.countRows()).toBe(0);
  });

  it("deleteRepo() does not affect other repos", async () => {
    await store.open(DIMS);
    const otherRepo = "/home/dev/otherrepo";
    await store.upsertFile(REPO_ID, "src/a.ts", [makeChunk("src/a.ts", 0)], [makeEmbedding(1)]);
    await store.upsertFile(
      otherRepo,
      "src/b.ts",
      [{ ...makeChunk("src/b.ts", 0), repoId: otherRepo }],
      [makeEmbedding(2)],
    );
    await store.deleteRepo(REPO_ID);
    expect(await store.countRows()).toBe(1);
  });

  // ── listRepoIds ─────────────────────────────────────────────────────────────

  it("listRepoIds() returns all distinct repo IDs", async () => {
    await store.open(DIMS);
    const repo2 = "/home/dev/repo2";
    await store.upsertFile(REPO_ID, "src/a.ts", [makeChunk("src/a.ts", 0)], [makeEmbedding(1)]);
    await store.upsertFile(
      repo2,
      "src/b.ts",
      [{ ...makeChunk("src/b.ts", 0), repoId: repo2 }],
      [makeEmbedding(2)],
    );
    const ids = await store.listRepoIds();
    expect(ids).toContain(REPO_ID);
    expect(ids).toContain(repo2);
    expect(ids).toHaveLength(2);
  });

  it("listRepoIds() returns empty array when table is empty", async () => {
    await store.open(DIMS);
    expect(await store.listRepoIds()).toHaveLength(0);
  });

  // ── purgeOlderThan ──────────────────────────────────────────────────────────

  it("purgeOlderThan() removes rows indexed before the cutoff", async () => {
    await store.open(DIMS);
    await store.upsertFile(REPO_ID, "src/a.ts", [makeChunk("src/a.ts", 0)], [makeEmbedding(1)]);
    // Purge with a future date — all rows should be removed
    const future = new Date(Date.now() + 86400_000).toISOString();
    await store.purgeOlderThan(future);
    expect(await store.countRows()).toBe(0);
  });

  it("purgeOlderThan() keeps rows indexed after the cutoff", async () => {
    await store.open(DIMS);
    await store.upsertFile(REPO_ID, "src/a.ts", [makeChunk("src/a.ts", 0)], [makeEmbedding(1)]);
    // Purge with a past date — no rows should be removed
    const past = new Date(Date.now() - 86400_000).toISOString();
    await store.purgeOlderThan(past);
    expect(await store.countRows()).toBe(1);
  });

  // ── search ──────────────────────────────────────────────────────────────────

  it("search() returns results for a populated store", async () => {
    await store.open(DIMS);
    await store.upsertFile(REPO_ID, "src/a.ts", [makeChunk("src/a.ts", 0)], [makeEmbedding(1)]);
    const results = await store.search(makeVector(1), 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("_distance");
  });

  it("searchInRepo() restricts results to the given repo", async () => {
    await store.open(DIMS);
    const repo2 = "/home/dev/repo2";
    await store.upsertFile(REPO_ID, "src/a.ts", [makeChunk("src/a.ts", 0)], [makeEmbedding(1)]);
    await store.upsertFile(
      repo2,
      "src/b.ts",
      [{ ...makeChunk("src/b.ts", 0), repoId: repo2 }],
      [makeEmbedding(2)],
    );
    const results = await store.searchInRepo(makeVector(1), REPO_ID, 10);
    for (const result of results) {
      expect(result.repo_id).toBe(REPO_ID);
    }
  });
});
