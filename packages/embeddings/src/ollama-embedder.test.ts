import { beforeEach, describe, expect, it, mock } from "bun:test";

import { OllamaEmbedder, isOllamaReachable } from "./ollama-embedder";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeVector(dims: number): number[] {
  return Array.from({ length: dims }, (_, i) => i / dims);
}

function mockFetchOk(embeddings: number[][]): void {
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ embeddings }), { status: 200 }),
  ) as unknown as typeof fetch;
}

function mockFetchError(status: number, body = "error"): void {
  globalThis.fetch = mock(async () => new Response(body, { status })) as unknown as typeof fetch;
}

function mockFetchThrow(): void {
  globalThis.fetch = mock(async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
}

// ── OllamaEmbedder ───────────────────────────────────────────────────────────

describe("OllamaEmbedder", () => {
  beforeEach(() => {
    // Reset fetch mock before each test
    globalThis.fetch = fetch;
  });

  it("embed() returns a Float32Array of the correct length", async () => {
    mockFetchOk([makeVector(768)]);
    const embedder = new OllamaEmbedder();
    const result = await embedder.embed("hello");
    expect(result.vector).toBeInstanceOf(Float32Array);
    expect(result.vector.length).toBe(768);
  });

  it("embed() sends the correct model and input to Ollama", async () => {
    let capturedBody: unknown;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ embeddings: [makeVector(768)] }), { status: 200 });
    }) as unknown as typeof fetch;

    const embedder = new OllamaEmbedder("nomic-embed-text", "http://localhost:11434");
    await embedder.embed("test text");

    expect(capturedBody).toMatchObject({ model: "nomic-embed-text", input: ["test text"] });
  });

  it("embedBatch() returns one result per input", async () => {
    mockFetchOk([makeVector(768), makeVector(768), makeVector(768)]);
    const embedder = new OllamaEmbedder();
    const results = await embedder.embedBatch(["a", "b", "c"]);
    expect(results).toHaveLength(3);
  });

  it("embedBatch() returns empty array for empty input", async () => {
    const embedder = new OllamaEmbedder();
    const results = await embedder.embedBatch([]);
    expect(results).toHaveLength(0);
  });

  it("embedBatch() throws when Ollama returns non-ok status", async () => {
    mockFetchError(500, "internal server error");
    const embedder = new OllamaEmbedder();
    await expect(embedder.embedBatch(["text"])).rejects.toThrow("500");
  });

  it("embedBatch() throws when embedding count mismatches input count", async () => {
    mockFetchOk([makeVector(768)]); // returns 1 but we send 2
    const embedder = new OllamaEmbedder();
    await expect(embedder.embedBatch(["a", "b"])).rejects.toThrow("2");
  });

  it("dimensions resolves to the vector length after first embed", async () => {
    mockFetchOk([makeVector(768)]);
    const embedder = new OllamaEmbedder();
    const dims = await embedder.dimensions;
    expect(dims).toBe(768);
  });

  it("dimensions is cached after first resolution", async () => {
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      return new Response(JSON.stringify({ embeddings: [makeVector(768)] }), { status: 200 });
    }) as unknown as typeof fetch;

    const embedder = new OllamaEmbedder();
    await embedder.dimensions;
    await embedder.dimensions;
    // Only one fetch call for dimensions probe + one for embed = 2 total
    // but second dimensions access should not call fetch again
    expect(callCount).toBe(1);
  });

  it("uses custom model name in request", async () => {
    let capturedBody: unknown;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ embeddings: [makeVector(512)] }), { status: 200 });
    }) as unknown as typeof fetch;

    const embedder = new OllamaEmbedder("mxbai-embed-large");
    await embedder.embed("text");
    expect(capturedBody).toMatchObject({ model: "mxbai-embed-large" });
  });
});

// ── isOllamaReachable ─────────────────────────────────────────────────────────

describe("isOllamaReachable", () => {
  it("returns true when Ollama responds with ok status", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    expect(await isOllamaReachable()).toBe(true);
  });

  it("returns false when Ollama responds with error status", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 503 }),
    ) as unknown as typeof fetch;
    expect(await isOllamaReachable()).toBe(false);
  });

  it("returns false when fetch throws (connection refused)", async () => {
    mockFetchThrow();
    expect(await isOllamaReachable()).toBe(false);
  });
});
