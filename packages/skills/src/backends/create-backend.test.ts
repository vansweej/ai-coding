import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceStore } from "../store/lance-store";
import { createBestBackend } from "./create-backend";
import { FileBackend } from "./file-backend";
import { VectorBackend } from "./vector-backend";

// ── helpers ──────────────────────────────────────────────────────────────────

const DIMS = 4;

/** Create a real (but empty) LanceDB at dbPath so lanceDbExists() returns true. */
async function seedLanceDb(dbPath: string): Promise<void> {
  const store = new LanceStore(dbPath);
  await store.open(DIMS);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("createBestBackend", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "create-backend-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    globalThis.fetch = fetch;
  });

  it("returns FileBackend when Ollama is unreachable", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;

    const backend = await createBestBackend({ skillRoot: tmpDir });
    expect(backend).toBeInstanceOf(FileBackend);
  });

  it("returns FileBackend when DB does not exist (even if Ollama is up)", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

    const backend = await createBestBackend({
      skillRoot: tmpDir,
      dbPath: join(tmpDir, "nonexistent.lance"),
    });
    expect(backend).toBeInstanceOf(FileBackend);
  });

  it("returns VectorBackend when Ollama is reachable and DB exists", async () => {
    const dbPath = join(tmpDir, "skills.lance");
    await seedLanceDb(dbPath);

    // First call: /api/tags (health check); subsequent calls: embed
    globalThis.fetch = mock(async (url: string) => {
      if (String(url).includes("/api/tags")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      // embed probe
      return new Response(JSON.stringify({ embeddings: [Array.from({ length: DIMS }, () => 0)] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const backend = await createBestBackend({ dbPath, skillRoot: tmpDir });
    expect(backend).toBeInstanceOf(VectorBackend);
  });

  it("uses custom ollamaModel option", async () => {
    const dbPath = join(tmpDir, "skills.lance");
    await seedLanceDb(dbPath);

    let capturedBody: unknown;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/tags")) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      }
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ embeddings: [Array.from({ length: DIMS }, () => 0)] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const backend = await createBestBackend({
      dbPath,
      skillRoot: tmpDir,
      ollamaModel: "mxbai-embed-large",
    });

    // Trigger an embed call to verify the model name is passed through
    await backend.resolve({ action: "edit", query: "test" });
    expect(capturedBody).toMatchObject({ model: "mxbai-embed-large" });
  });
});
