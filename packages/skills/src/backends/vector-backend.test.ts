import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Embedder, EmbeddingResult } from "@ai-coding/embeddings";

import type { SkillChunk } from "../chunking/markdown-chunker";
import { LanceStore } from "../store/lance-store";
import { VectorBackend } from "./vector-backend";

// ── mock embedder ─────────────────────────────────────────────────────────────

const DIMS = 4;

class MockEmbedder implements Embedder {
  readonly dimensions = Promise.resolve(DIMS);

  private readonly fixedVector: Float32Array;

  constructor(vector: Float32Array = new Float32Array([1, 0, 0, 0])) {
    this.fixedVector = vector;
  }

  async embed(_text: string): Promise<EmbeddingResult> {
    return { vector: this.fixedVector };
  }

  async embedBatch(texts: readonly string[]): Promise<readonly EmbeddingResult[]> {
    return texts.map(() => ({ vector: this.fixedVector }));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function makeChunk(skillName: string, index: number, text: string): SkillChunk {
  return { skillName, chunkIndex: index, text };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("VectorBackend", () => {
  let tmpDir: string;
  let store: LanceStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "vector-backend-test-"));
    store = new LanceStore(join(tmpDir, "skills.lance"));
    await store.open(DIMS);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when store is empty", async () => {
    const backend = new VectorBackend(new MockEmbedder(), store);
    const results = await backend.resolve({ action: "edit" });
    expect(results).toHaveLength(0);
  });

  it("returns a ResolvedSkill for each unique skill in results", async () => {
    await store.upsertSkill(
      "programmer",
      [makeChunk("programmer", 0, "Write clean code.")],
      [{ vector: new Float32Array([1, 0, 0, 0]) }],
    );
    await store.upsertSkill(
      "debugger",
      [makeChunk("debugger", 0, "Trace errors carefully.")],
      [{ vector: new Float32Array([0.9, 0.1, 0, 0]) }],
    );

    const backend = new VectorBackend(new MockEmbedder(), store);
    const results = await backend.resolve({ action: "edit" });

    const names = results.map((r) => r.name);
    expect(names).toContain("programmer");
    expect(names).toContain("debugger");
  });

  it("each result has a relevance score between 0 and 1", async () => {
    await store.upsertSkill(
      "programmer",
      [makeChunk("programmer", 0, "Write clean code.")],
      [{ vector: new Float32Array([1, 0, 0, 0]) }],
    );

    const backend = new VectorBackend(new MockEmbedder(), store);
    const results = await backend.resolve({ action: "edit" });

    for (const r of results) {
      expect(r.relevance).toBeGreaterThanOrEqual(0);
      expect(r.relevance).toBeLessThanOrEqual(1);
    }
  });

  it("respects the token budget — excludes chunks that would exceed it", async () => {
    // Each chunk is ~500 chars; budget of 100 tokens = 400 chars → only 0 or 1 chunk fits
    const longText = "x".repeat(500);
    await store.upsertSkill(
      "skill-a",
      [makeChunk("skill-a", 0, longText)],
      [{ vector: new Float32Array([1, 0, 0, 0]) }],
    );
    await store.upsertSkill(
      "skill-b",
      [makeChunk("skill-b", 0, longText)],
      [{ vector: new Float32Array([0.9, 0.1, 0, 0]) }],
    );

    const backend = new VectorBackend(new MockEmbedder(), store, 100); // 100 tokens = 400 chars
    const results = await backend.resolve({ action: "edit" });

    // At most one skill should fit within the budget
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("concatenates multiple chunks from the same skill", async () => {
    await store.upsertSkill(
      "programmer",
      [
        makeChunk("programmer", 0, "## Rules\n\nWrite clean code."),
        makeChunk("programmer", 1, "## Workflow\n\nTest everything."),
      ],
      [
        { vector: new Float32Array([1, 0, 0, 0]) },
        { vector: new Float32Array([0.95, 0.05, 0, 0]) },
      ],
    );

    const backend = new VectorBackend(new MockEmbedder(), store, 10000);
    const results = await backend.resolve({ action: "edit" });

    const prog = results.find((r) => r.name === "programmer");
    expect(prog).toBeDefined();
    expect(prog?.content).toContain("Rules");
    expect(prog?.content).toContain("Workflow");
  });

  it("uses context.query to build the embedding query", async () => {
    let capturedText: string | undefined;
    const trackingEmbedder: Embedder = {
      dimensions: Promise.resolve(DIMS),
      async embed(text: string): Promise<EmbeddingResult> {
        capturedText = text;
        return { vector: new Float32Array([1, 0, 0, 0]) };
      },
      async embedBatch(texts: readonly string[]): Promise<readonly EmbeddingResult[]> {
        return texts.map(() => ({ vector: new Float32Array([1, 0, 0, 0]) }));
      },
    };

    const backend = new VectorBackend(trackingEmbedder, store);
    await backend.resolve({ action: "edit", query: "refactor the parser" });

    expect(capturedText).toContain("edit");
    expect(capturedText).toContain("refactor the parser");
  });

  it("works without context.query (action-only embedding)", async () => {
    let capturedText: string | undefined;
    const trackingEmbedder: Embedder = {
      dimensions: Promise.resolve(DIMS),
      async embed(text: string): Promise<EmbeddingResult> {
        capturedText = text;
        return { vector: new Float32Array([1, 0, 0, 0]) };
      },
      async embedBatch(texts: readonly string[]): Promise<readonly EmbeddingResult[]> {
        return texts.map(() => ({ vector: new Float32Array([1, 0, 0, 0]) }));
      },
    };

    const backend = new VectorBackend(trackingEmbedder, store);
    await backend.resolve({ action: "plan" });

    expect(capturedText).toBe("plan");
  });
});
