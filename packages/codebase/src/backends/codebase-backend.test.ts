import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Embedder, EmbeddingResult } from "@ai-coding/embeddings";

import type { ParserPool } from "../chunking/parser-pool";
import { indexCodebase } from "../indexer/index-codebase";
import { CodebaseStore } from "../store/codebase-store";
import { CodebaseBackend } from "./codebase-backend";

// ── mock helpers ──────────────────────────────────────────────────────────────

const DIMS = 4;

function mockEmbedder(dims = DIMS): Embedder {
  return {
    embed: async (_text: string): Promise<EmbeddingResult> => ({
      vector: new Float32Array(dims).fill(0.5),
    }),
    embedBatch: async (texts: readonly string[]): Promise<readonly EmbeddingResult[]> =>
      texts.map(() => ({ vector: new Float32Array(dims).fill(0.5) })),
    dimensions: Promise.resolve(dims),
  };
}

function noGrammarPool(): ParserPool {
  return {
    hasGrammar: () => false,
    getParser: async () => {
      throw new Error("no grammar");
    },
    grammarPath: (lang: string) => `/no/grammars/tree-sitter-${lang}.wasm`,
  } as unknown as ParserPool;
}

// ── git helpers ───────────────────────────────────────────────────────────────

async function initGitRepo(dir: string): Promise<void> {
  const run = (args: string[]) =>
    Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;
  await run(["git", "init"]);
  await run(["git", "config", "user.email", "test@test.com"]);
  await run(["git", "config", "user.name", "Test"]);
}

async function createFile(dir: string, rel: string, content = "hello world\n"): Promise<void> {
  const full = join(dir, rel);
  await mkdir(full.split("/").slice(0, -1).join("/"), { recursive: true });
  await writeFile(full, content);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("CodebaseBackend.search()", () => {
  let repoDir: string;
  let dbDir: string;
  let store: CodebaseStore;
  let metaPath: string;
  const embedder = mockEmbedder();
  const pool = noGrammarPool();

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "backend-repo-"));
    dbDir = await mkdtemp(join(tmpdir(), "backend-db-"));
    store = new CodebaseStore(dbDir);
    metaPath = join(dbDir, "test.meta.json");
    await initGitRepo(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  // ── cold repo → NoIndex ──────────────────────────────────────────────────────

  it("cold repo (never indexed) returns NoIndex, does not auto-index (refresh=true)", async () => {
    await createFile(repoDir, "src/main.ts", "export const greet = () => 'hello';\n");

    const backend = new CodebaseBackend(embedder, store, pool);
    const result = await backend.search("greeting function", repoDir, { refresh: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("no-index");
      expect(result.error.repoId).toBe(realpathSync(repoDir));
    }
  });

  it("cold repo (never indexed) returns NoIndex, does not auto-index (refresh=false)", async () => {
    await createFile(repoDir, "src/main.ts", "export const greet = () => 'hello';\n");

    const backend = new CodebaseBackend(embedder, store, pool);
    const result = await backend.search("greeting function", repoDir, { refresh: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("no-index");
    }
  });

  it("cold global store (no repoPath) returns NoIndex(undefined)", async () => {
    const backend = new CodebaseBackend(embedder, store, pool);
    const result = await backend.search("anything", undefined, { refresh: false });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("no-index");
      expect(result.error.repoId).toBeUndefined();
    }
  });

  // ── warm repo: basic search ──────────────────────────────────────────────────

  async function warmUp(dir: string): Promise<void> {
    await indexCodebase(embedder, store, pool, realpathSync(dir), { ttlDays: 3650 });
  }

  it("returns results after indexing a file (refresh=true)", async () => {
    await createFile(repoDir, "src/main.ts", "export const greet = () => 'hello';\n");
    await warmUp(repoDir);

    const backend = new CodebaseBackend(embedder, store, pool);
    const result = await backend.search("greeting function", repoDir, {
      refresh: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThan(0);
    }
  });

  it("a warmed but empty repo (no files ever indexed) is treated as NoIndex (symmetry with global empty store)", async () => {
    await warmUp(repoDir);
    const backend = new CodebaseBackend(embedder, store, pool);
    const result = await backend.search("anything", repoDir, { refresh: true });
    // indexCodebase() on an empty repo writes zero rows, so hasRepo() still
    // reports cold — same symmetry as the global-empty-store case.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("no-index");
    }
  });

  it("each result has the required fields", async () => {
    await createFile(
      repoDir,
      "lib/util.ts",
      "export function add(a: number, b: number) { return a + b; }\n",
    );
    await warmUp(repoDir);

    const backend = new CodebaseBackend(embedder, store, pool);
    const result = await backend.search("addition utility", repoDir, { refresh: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const r of result.value) {
      expect(typeof r.repoId).toBe("string");
      expect(typeof r.filePath).toBe("string");
      expect(typeof r.text).toBe("string");
      expect(typeof r.startLine).toBe("number");
      expect(typeof r.endLine).toBe("number");
      expect(typeof r.score).toBe("number");
      // symbolName and symbolKind may be null for fallback chunks
      expect(r.symbolName === null || typeof r.symbolName === "string").toBe(true);
      expect(r.symbolKind === null || typeof r.symbolKind === "string").toBe(true);
    }
  });

  it("result.repoId equals the repoPath argument", async () => {
    await createFile(repoDir, "index.ts", "const x = 1;\n");
    await warmUp(repoDir);

    const backend = new CodebaseBackend(embedder, store, pool);
    const result = await backend.search("variable", repoDir, { refresh: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const r of result.value) {
      expect(r.repoId).toBe(realpathSync(repoDir));
    }
  });

  it("result.filePath is relative (no leading /)", async () => {
    await createFile(repoDir, "src/app.ts", "const app = {};\n");
    await warmUp(repoDir);

    const backend = new CodebaseBackend(embedder, store, pool);
    const result = await backend.search("app", repoDir, { refresh: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const r of result.value) {
      expect(r.filePath.startsWith("/")).toBe(false);
    }
  });

  it("result.score is a number (1 − distance)", async () => {
    await createFile(repoDir, "src/foo.ts", "const foo = 42;\n");
    await warmUp(repoDir);

    const backend = new CodebaseBackend(embedder, store, pool);
    const result = await backend.search("constant", repoDir, { refresh: true });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const r of result.value) {
      expect(typeof r.score).toBe("number");
    }
  });

  // ── limit ────────────────────────────────────────────────────────────────────

  it("respects the limit option", async () => {
    // Create enough content to produce multiple chunks
    for (let i = 0; i < 5; i++) {
      await createFile(repoDir, `src/file${i}.ts`, `export const val${i} = ${i};\n`);
    }
    await warmUp(repoDir);

    const backend = new CodebaseBackend(embedder, store, pool);
    const result = await backend.search("value", repoDir, {
      refresh: true,
      limit: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeLessThanOrEqual(2);
    }
  });

  // ── refresh=false ─────────────────────────────────────────────────────────────

  it("refresh=false uses existing index without re-running indexCodebase", async () => {
    await createFile(repoDir, "src/cached.ts", "const cached = true;\n");
    await warmUp(repoDir);

    const backend = new CodebaseBackend(embedder, store, pool);

    const result = await backend.search("cache", repoDir, { refresh: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThan(0);
    }
  });

  // ── global search (no repoPath) ───────────────────────────────────────────────

  it("search without repoPath returns results across all repos", async () => {
    await createFile(repoDir, "src/main.ts", "const x = 1;\n");
    await warmUp(repoDir);

    const backend = new CodebaseBackend(embedder, store, pool);

    // Global search (no repoPath) — store is warm from the repo-scoped warm-up.
    const result = await backend.search("variable declaration", undefined, { refresh: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThan(0);
    }
  });

  // ── freshness: changed file is re-indexed ─────────────────────────────────────

  it("refresh=true picks up changes to a file between two searches", async () => {
    await createFile(repoDir, "src/counter.ts", "const counter = 0;\n");
    await warmUp(repoDir);

    const backend = new CodebaseBackend(embedder, store, pool);

    // First search — repo already warm from warmUp above.
    const result1 = await backend.search("counter", repoDir, { refresh: true });
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.value.length).toBeGreaterThan(0);
    }

    // Modify the file
    await writeFile(join(repoDir, "src/counter.ts"), "const counter = 999; // updated\n");

    // Second search — re-indexes the changed file
    const result2 = await backend.search("counter", repoDir, { refresh: true });
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.value.length).toBeGreaterThan(0);
      // At least one result should contain the updated content
      const hasUpdated = result2.value.some((r) => r.text.includes("999"));
      expect(hasUpdated).toBe(true);
    }
  });
});
