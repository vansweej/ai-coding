import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ignore from "ignore";

import type { EmbeddingResult } from "@ai-coding/embeddings";

import type { CodeChunk } from "../chunk-types";
import { CodebaseStore } from "../store/codebase-store";
import { purgeDeadRepos, purgeRepo, purgeStale, runPostIndexPurge } from "./purge";

// ── helpers ───────────────────────────────────────────────────────────────────

const DIMS = 4;

function makeVector(): Float32Array {
  return new Float32Array([0.1, 0.2, 0.3, 0.4]);
}

function makeEmbedding(): EmbeddingResult {
  return { vector: makeVector() };
}

function makeChunk(repoId: string, filePath: string): CodeChunk {
  return {
    repoId,
    filePath,
    symbolName: null,
    symbolKind: null,
    text: `content of ${filePath}`,
    chunkIndex: 0,
    startLine: 1,
    endLine: 5,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("purgeStale", () => {
  let tmpDir: string;
  let store: CodebaseStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "purge-test-"));
    store = new CodebaseStore(tmpDir);
    await store.open(DIMS);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns an ISO-8601 date string", async () => {
    const cutoff = await purgeStale(store, tmpDir, null, 30);
    expect(() => new Date(cutoff)).not.toThrow();
    expect(new Date(cutoff).toISOString()).toBe(cutoff);
  });

  it("removes rows indexed before the cutoff (ttlDays = -1 → cutoff tomorrow)", async () => {
    const repoId = tmpDir;
    await store.upsertFile(repoId, "a.ts", [makeChunk(repoId, "a.ts")], [makeEmbedding()]);
    expect(await store.countRows()).toBe(1);

    // ttlDays = -1 makes the cutoff 1 day in the future → all rows purged
    await purgeStale(store, repoId, null, -1);
    expect(await store.countRows()).toBe(0);
  });

  it("keeps rows indexed within the TTL window", async () => {
    const repoId = tmpDir;
    await store.upsertFile(repoId, "a.ts", [makeChunk(repoId, "a.ts")], [makeEmbedding()]);

    // ttlDays = 3650 → cutoff 10 years ago → no recently-indexed rows removed
    await purgeStale(store, repoId, null, 3650);
    expect(await store.countRows()).toBe(1);
  });

  it("is a no-op on an empty table", async () => {
    const cutoff = await purgeStale(store, tmpDir);
    expect(typeof cutoff).toBe("string");
    expect(await store.countRows()).toBe(0);
  });

  it("only removes stale rows for the requested repo", async () => {
    const otherRepo = "/some/other/repo";
    await store.upsertFile(tmpDir, "a.ts", [makeChunk(tmpDir, "a.ts")], [makeEmbedding()]);
    await store.upsertFile(otherRepo, "b.ts", [makeChunk(otherRepo, "b.ts")], [makeEmbedding()]);

    await purgeStale(store, tmpDir, null, -1);

    expect(await store.countRows()).toBe(1);
  });

  it("keeps stale rows under exempt prefixes", async () => {
    await store.upsertFile(
      tmpDir,
      "GeometricTools/a.h",
      [makeChunk(tmpDir, "GeometricTools/a.h")],
      [makeEmbedding()],
    );
    await store.upsertFile(tmpDir, "src/a.ts", [makeChunk(tmpDir, "src/a.ts")], [makeEmbedding()]);

    await purgeStale(store, tmpDir, ignore().add(["GeometricTools/"]), -1);

    expect(await store.countRows()).toBe(1);
  });
});

describe("purgeDeadRepos", () => {
  let tmpDir: string;
  let store: CodebaseStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "purge-dead-test-"));
    store = new CodebaseStore(tmpDir);
    await store.open(DIMS);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no dead repos exist", async () => {
    // Insert rows with a live repo (tmpDir itself exists)
    await store.upsertFile(tmpDir, "a.ts", [makeChunk(tmpDir, "a.ts")], [makeEmbedding()]);
    const dead = await purgeDeadRepos(store);
    expect(dead).toHaveLength(0);
    expect(await store.countRows()).toBe(1);
  });

  it("removes rows for a repo whose directory does not exist", async () => {
    const deadRepo = "/nonexistent/path/that/definitely/does/not/exist/xyz123";
    await store.upsertFile(deadRepo, "a.ts", [makeChunk(deadRepo, "a.ts")], [makeEmbedding()]);
    expect(await store.countRows()).toBe(1);

    const dead = await purgeDeadRepos(store);
    expect(dead).toContain(deadRepo);
    expect(await store.countRows()).toBe(0);
  });

  it("returns the list of purged repo IDs", async () => {
    const deadRepo = "/nonexistent/path/xyz789";
    await store.upsertFile(deadRepo, "b.ts", [makeChunk(deadRepo, "b.ts")], [makeEmbedding()]);

    const dead = await purgeDeadRepos(store);
    expect(dead).toEqual([deadRepo]);
  });

  it("keeps rows for repos whose directory exists and removes rows for dead ones", async () => {
    const deadRepo = "/nonexistent/abc456";
    await store.upsertFile(tmpDir, "a.ts", [makeChunk(tmpDir, "a.ts")], [makeEmbedding()]);
    await store.upsertFile(deadRepo, "b.ts", [makeChunk(deadRepo, "b.ts")], [makeEmbedding()]);

    expect(await store.countRows()).toBe(2);
    const dead = await purgeDeadRepos(store);

    expect(dead).toEqual([deadRepo]);
    expect(await store.countRows()).toBe(1); // only tmpDir row remains
  });

  it("returns empty array on an empty table", async () => {
    const dead = await purgeDeadRepos(store);
    expect(dead).toHaveLength(0);
  });
});

describe("purgeRepo", () => {
  let tmpDir: string;
  let store: CodebaseStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "purge-repo-test-"));
    store = new CodebaseStore(tmpDir);
    await store.open(DIMS);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("deletes all chunks for the given repo", async () => {
    const repoId = "/some/repo";
    await store.upsertFile(repoId, "a.ts", [makeChunk(repoId, "a.ts")], [makeEmbedding()]);
    expect(await store.countRows()).toBe(1);

    await purgeRepo(store, repoId);
    expect(await store.countRows()).toBe(0);
  });

  it("does not affect other repos", async () => {
    const repoA = "/repo/a";
    const repoB = "/repo/b";
    await store.upsertFile(repoA, "a.ts", [makeChunk(repoA, "a.ts")], [makeEmbedding()]);
    await store.upsertFile(repoB, "b.ts", [makeChunk(repoB, "b.ts")], [makeEmbedding()]);

    await purgeRepo(store, repoA);
    expect(await store.countRows()).toBe(1);
  });

  it("is a no-op for a repo with no rows", async () => {
    await expect(purgeRepo(store, "/nonexistent/repo")).resolves.toBeUndefined();
    expect(await store.countRows()).toBe(0);
  });
});

describe("runPostIndexPurge", () => {
  let tmpDir: string;
  let store: CodebaseStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "post-purge-test-"));
    store = new CodebaseStore(tmpDir);
    await store.open(DIMS);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a PurgeResult with staleBefore and deadRepos", async () => {
    const result = await runPostIndexPurge(store, tmpDir, null, 30);
    expect(result).toHaveProperty("staleBefore");
    expect(result).toHaveProperty("deadRepos");
    expect(Array.isArray(result.deadRepos)).toBe(true);
  });

  it("removes stale rows (ttlDays = -1)", async () => {
    const repoId = tmpDir;
    await store.upsertFile(repoId, "a.ts", [makeChunk(repoId, "a.ts")], [makeEmbedding()]);
    expect(await store.countRows()).toBe(1);

    await runPostIndexPurge(store, repoId, null, -1);
    expect(await store.countRows()).toBe(0);
  });

  it("purges dead repos in addition to stale rows", async () => {
    const deadRepo = "/nonexistent/repo/for/post/purge";
    await store.upsertFile(deadRepo, "x.ts", [makeChunk(deadRepo, "x.ts")], [makeEmbedding()]);

    const result = await runPostIndexPurge(store, tmpDir, null, 3650); // keep fresh rows, only purge dead
    expect(result.deadRepos).toContain(deadRepo);
    expect(await store.countRows()).toBe(0);
  });

  it("only TTL-purges rows for the requested repo", async () => {
    const otherRepo = await mkdtemp(join(tmpdir(), "post-purge-live-repo-"));
    try {
      await store.upsertFile(tmpDir, "a.ts", [makeChunk(tmpDir, "a.ts")], [makeEmbedding()]);
      await store.upsertFile(otherRepo, "b.ts", [makeChunk(otherRepo, "b.ts")], [makeEmbedding()]);

      await runPostIndexPurge(store, tmpDir, null, -1);

      expect(await store.countRows()).toBe(1);
    } finally {
      await rm(otherRepo, { recursive: true, force: true });
    }
  });

  it("threads exempt prefixes through the TTL purge", async () => {
    await store.upsertFile(
      tmpDir,
      "GeometricTools/a.h",
      [makeChunk(tmpDir, "GeometricTools/a.h")],
      [makeEmbedding()],
    );
    await store.upsertFile(tmpDir, "src/a.ts", [makeChunk(tmpDir, "src/a.ts")], [makeEmbedding()]);

    await runPostIndexPurge(store, tmpDir, ignore().add(["GeometricTools/"]), -1);

    expect(await store.countRows()).toBe(1);
  });
});
