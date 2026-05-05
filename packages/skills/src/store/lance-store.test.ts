import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SkillChunk } from "../chunking/markdown-chunker";
import type { EmbeddingResult } from "../embeddings/embedder-types";
import { LanceStore } from "./lance-store";

// ── helpers ──────────────────────────────────────────────────────────────────

const DIMS = 4;

function makeVector(seed: number): Float32Array {
  return new Float32Array([seed, seed + 0.1, seed + 0.2, seed + 0.3]);
}

function makeChunk(skillName: string, index: number, text: string): SkillChunk {
  return { skillName, chunkIndex: index, text };
}

function makeEmbedding(seed: number): EmbeddingResult {
  return { vector: makeVector(seed) };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("LanceStore", () => {
  let tmpDir: string;
  let store: LanceStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lance-store-test-"));
    store = new LanceStore(join(tmpDir, "skills.lance"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws when used before open()", async () => {
    await expect(store.countRows()).rejects.toThrow("not opened");
  });

  it("open() creates a new table when none exists", async () => {
    await store.open(DIMS);
    expect(await store.countRows()).toBe(0);
  });

  it("open() is idempotent — safe to call multiple times", async () => {
    await store.open(DIMS);
    await store.open(DIMS);
    expect(await store.countRows()).toBe(0);
  });

  it("open() without dimensions throws when table does not exist", async () => {
    await expect(store.open()).rejects.toThrow("dimensions required");
  });

  it("open() without dimensions succeeds when table already exists", async () => {
    await store.open(DIMS);
    const store2 = new LanceStore(join(tmpDir, "skills.lance"));
    await expect(store2.open()).resolves.toBeUndefined();
  });

  it("upsertSkill() inserts chunks into the table", async () => {
    await store.open(DIMS);
    const chunks = [makeChunk("programmer", 0, "Write clean code.")];
    const embeddings = [makeEmbedding(0.1)];
    await store.upsertSkill("programmer", chunks, embeddings);
    expect(await store.countRows()).toBe(1);
  });

  it("upsertSkill() replaces existing rows for the same skill", async () => {
    await store.open(DIMS);
    await store.upsertSkill(
      "programmer",
      [makeChunk("programmer", 0, "old text")],
      [makeEmbedding(0.1)],
    );
    await store.upsertSkill(
      "programmer",
      [makeChunk("programmer", 0, "new text"), makeChunk("programmer", 1, "extra")],
      [makeEmbedding(0.2), makeEmbedding(0.3)],
    );
    expect(await store.countRows()).toBe(2);
  });

  it("upsertSkill() does not affect rows from other skills", async () => {
    await store.open(DIMS);
    await store.upsertSkill(
      "debugger",
      [makeChunk("debugger", 0, "debug text")],
      [makeEmbedding(0.5)],
    );
    await store.upsertSkill(
      "programmer",
      [makeChunk("programmer", 0, "prog text")],
      [makeEmbedding(0.1)],
    );
    expect(await store.countRows()).toBe(2);
  });

  it("upsertSkill() with empty chunks deletes existing rows", async () => {
    await store.open(DIMS);
    await store.upsertSkill(
      "programmer",
      [makeChunk("programmer", 0, "text")],
      [makeEmbedding(0.1)],
    );
    await store.upsertSkill("programmer", [], []);
    expect(await store.countRows()).toBe(0);
  });

  it("upsertSkill() throws when chunks and embeddings lengths differ", async () => {
    await store.open(DIMS);
    await expect(
      store.upsertSkill("programmer", [makeChunk("programmer", 0, "text")], []),
    ).rejects.toThrow("chunks.length");
  });

  it("search() returns the closest chunk", async () => {
    await store.open(DIMS);
    await store.upsertSkill(
      "programmer",
      [makeChunk("programmer", 0, "Write clean code.")],
      [{ vector: new Float32Array([1, 0, 0, 0]) }],
    );
    await store.upsertSkill(
      "debugger",
      [makeChunk("debugger", 0, "Debug carefully.")],
      [{ vector: new Float32Array([0, 1, 0, 0]) }],
    );
    const results = await store.search(new Float32Array([1, 0, 0, 0]), 1);
    expect(results).toHaveLength(1);
    expect(results[0]?.skill_name).toBe("programmer");
  });

  it("search() returns up to limit results", async () => {
    await store.open(DIMS);
    for (let i = 0; i < 5; i++) {
      await store.upsertSkill(
        `skill-${i}`,
        [makeChunk(`skill-${i}`, 0, `text ${i}`)],
        [makeEmbedding(i * 0.1)],
      );
    }
    const results = await store.search(new Float32Array([0, 0, 0, 0]), 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("search() results include _distance field", async () => {
    await store.open(DIMS);
    await store.upsertSkill(
      "programmer",
      [makeChunk("programmer", 0, "text")],
      [{ vector: new Float32Array([1, 0, 0, 0]) }],
    );
    const results = await store.search(new Float32Array([1, 0, 0, 0]), 1);
    expect(typeof results[0]?._distance).toBe("number");
  });

  it("deleteSkill() removes all rows for that skill", async () => {
    await store.open(DIMS);
    await store.upsertSkill(
      "programmer",
      [makeChunk("programmer", 0, "text")],
      [makeEmbedding(0.1)],
    );
    await store.deleteSkill("programmer");
    expect(await store.countRows()).toBe(0);
  });

  it("deleteSkill() is a no-op when skill has no rows", async () => {
    await store.open(DIMS);
    await expect(store.deleteSkill("nonexistent")).resolves.toBeUndefined();
  });
});
