import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Embedder, EmbeddingResult } from "@ai-coding/embeddings";

import type { ParserPool } from "../chunking/parser-pool";
import { CodebaseStore } from "../store/codebase-store";
import { TotalExclusionError, indexCodebase } from "./index-codebase";

// ── mock helpers ──────────────────────────────────────────────────────────────

const DIMS = 4;

/** Mock embedder that returns zero vectors without calling Ollama. */
function mockEmbedder(dims = DIMS): Embedder {
  return {
    embed: async (_text: string): Promise<EmbeddingResult> => ({
      vector: new Float32Array(dims).fill(0.1),
    }),
    embedBatch: async (texts: readonly string[]): Promise<readonly EmbeddingResult[]> =>
      texts.map(() => ({ vector: new Float32Array(dims).fill(0.1) })),
    dimensions: Promise.resolve(dims),
  };
}

/** Mock ParserPool with no grammars → always uses fallback chunker. */
function noGrammarPool(): ParserPool {
  return {
    hasGrammar: () => false,
    getParser: async () => {
      throw new Error("no grammar installed");
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

async function createFile(
  dir: string,
  relativePath: string,
  content = "hello world\n",
): Promise<void> {
  const full = join(dir, relativePath);
  await mkdir(full.split("/").slice(0, -1).join("/"), { recursive: true });
  await writeFile(full, content);
}

// ── fixtures ──────────────────────────────────────────────────────────────────

describe("indexCodebase", () => {
  let repoDir: string;
  let dbDir: string;
  let store: CodebaseStore;
  let metaPath: string;
  const embedder = mockEmbedder();
  const pool = noGrammarPool();

  beforeEach(async () => {
    // Create a fresh git repo and an isolated LanceDB dir for each test
    repoDir = await mkdtemp(join(tmpdir(), "index-codebase-repo-"));
    dbDir = await mkdtemp(join(tmpdir(), "index-codebase-db-"));
    store = new CodebaseStore(dbDir);
    metaPath = join(dbDir, "test.meta.json");
    await initGitRepo(repoDir);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  });

  // ── basic indexing ───────────────────────────────────────────────────────────

  it("indexes a single file and returns it in result.indexed", async () => {
    await createFile(repoDir, "src/main.ts", "const x = 1;\n");

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.indexed).toContain("src/main.ts");
    expect(result.skipped).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it("result.repoId equals the repoPath argument", async () => {
    await createFile(repoDir, "README.md");

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.repoId).toBe(realpathSync(repoDir));
  });

  it("indexed file names are relative to the repo root", async () => {
    await createFile(repoDir, "src/lib.rs", "fn main() {}");

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    // Must be relative, not absolute
    expect(result.indexed[0]).toBe("src/lib.rs");
    expect(result.indexed[0]?.startsWith("/")).toBe(false);
  });

  it("inserts rows into the store for discovered files", async () => {
    await createFile(repoDir, "hello.ts", "export const hi = 'hello';\n");

    await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });

    expect(await store.countRows()).toBeGreaterThan(0);
  });

  it("handles an empty repo (no files discovered)", async () => {
    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.indexed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(await store.countRows()).toBe(0);
  });

  it("writes the meta file after a successful run", async () => {
    await createFile(repoDir, "index.ts", "export default 42;\n");

    await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });

    const file = Bun.file(metaPath);
    expect(await file.exists()).toBe(true);
    const meta = (await file.json()) as { repos: Record<string, unknown> };
    expect(meta.repos[realpathSync(repoDir)]).toBeDefined();
  });

  // ── staleness detection ──────────────────────────────────────────────────────

  it("skips unchanged files on a second run", async () => {
    await createFile(repoDir, "src/main.ts", "const x = 1;\n");

    // First run — file is new → indexed
    await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });

    // Second run — same content → skipped
    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.skipped).toContain("src/main.ts");
    expect(result.indexed).toHaveLength(0);
  });

  it("re-indexes a file when its content changes", async () => {
    await createFile(repoDir, "src/main.ts", "const x = 1;\n");
    await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });

    // Modify the file
    await writeFile(join(repoDir, "src/main.ts"), "const x = 2; // changed\n");

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.indexed).toContain("src/main.ts");
    expect(result.skipped).toHaveLength(0);
  });

  it("force=true re-indexes all files regardless of hash", async () => {
    await createFile(repoDir, "src/main.ts", "const x = 1;\n");
    await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });

    // Second run with force=true — same content but still re-indexed
    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
      force: true,
    });

    expect(result.indexed).toContain("src/main.ts");
    expect(result.skipped).toHaveLength(0);
  });

  // ── deletion of removed files ────────────────────────────────────────────────

  it("deletes store rows for files removed from the repo", async () => {
    await createFile(repoDir, "src/keep.ts", "export const keep = true;\n");
    await createFile(repoDir, "src/remove.ts", "export const remove = true;\n");

    await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });
    const rowsAfterFirstIndex = await store.countRows();
    expect(rowsAfterFirstIndex).toBeGreaterThan(0);

    // Remove the file from the filesystem (discoverFiles uses --others so it disappears)
    await unlink(join(repoDir, "src/remove.ts"));

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.deleted).toContain("src/remove.ts");

    // Rows for src/keep.ts should remain; rows for src/remove.ts should be gone
    const rowsAfterSecondIndex = await store.countRows();
    expect(rowsAfterSecondIndex).toBeLessThan(rowsAfterFirstIndex);
  });

  it("reports deleted files without error even when they had multiple chunks", async () => {
    // A file large enough to produce multiple fallback chunks
    const big = Array.from({ length: 20 }, (_, i) => `paragraph ${i}\n`).join("\n");
    await createFile(repoDir, "docs/big.md", big);

    await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });
    await unlink(join(repoDir, "docs/big.md"));

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.deleted).toContain("docs/big.md");
    expect(await store.countRows()).toBe(0);
  });

  // ── purge result ─────────────────────────────────────────────────────────────

  it("result includes staleBefore ISO date string", async () => {
    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.staleBefore).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("result includes deadRepos array", async () => {
    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(Array.isArray(result.deadRepos)).toBe(true);
  });

  it("result includes keepPatterns from the .ai-coding-keep control file", async () => {
    await createFile(repoDir, ".ai-coding-keep", "GeometricTools/\n");
    await createFile(repoDir, "GeometricTools/GTE/file.h", "class Example {};\n");

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.keepPatterns).toEqual(["GeometricTools/"]);
  });

  it("result keepPatterns is empty when no .ai-coding-keep file is present", async () => {
    await createFile(repoDir, "src/main.ts", "const x = 1;\n");

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.keepPatterns).toEqual([]);
  });

  it("refreshes skipped files so they survive the TTL purge", async () => {
    await createFile(repoDir, "stable.ts", "export const stable = true;\n");

    await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });
    await store.touchRepo(
      realpathSync(repoDir),
      new Date(Date.now() - 3 * 86400_000).toISOString(),
    );

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 1,
    });

    expect(result.skipped).toContain("stable.ts");
    expect(await store.countRows()).toBeGreaterThan(0);
  });

  // ── meta persistence ─────────────────────────────────────────────────────────

  it("persists file hashes so the third run also skips unchanged files", async () => {
    await createFile(repoDir, "stable.ts", "export const n = 0;\n");

    await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });
    await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });
    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });

    expect(result.skipped).toContain("stable.ts");
    expect(result.indexed).toHaveLength(0);
  });

  it("handles a corrupted meta file gracefully (re-indexes all)", async () => {
    await createFile(repoDir, "src/app.ts", "const a = 1;\n");
    // Write invalid JSON to the meta file
    await Bun.write(metaPath, "{ not valid json !!!");

    // Should not throw; treats corrupted meta as empty → re-indexes
    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
    });
    expect(result.indexed).toContain("src/app.ts");
  });

  // ── file size cap ────────────────────────────────────────────────────────────

  it("skips files exceeding maxFileSizeBytes and reports them in oversized", async () => {
    await createFile(repoDir, "big.h", "x".repeat(200));

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
      maxFileSizeBytes: 10,
    });

    expect(result.oversized).toContain("big.h");
    expect(result.indexed).not.toContain("big.h");
    expect(await store.countRows()).toBe(0);
  });

  it("indexes files at exactly the maxFileSizeBytes limit", async () => {
    const content = "x".repeat(10);
    await createFile(repoDir, "exact.h", content);

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
      maxFileSizeBytes: 10,
    });

    expect(result.indexed).toContain("exact.h");
    expect(result.oversized).not.toContain("exact.h");
  });

  it("preserves hash sentinel so oversized files stay skipped on re-run", async () => {
    await createFile(repoDir, "big.h", "x".repeat(200));

    await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
      maxFileSizeBytes: 10,
    });

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
      maxFileSizeBytes: 10,
    });

    expect(result.oversized).toContain("big.h");
    expect(result.indexed).not.toContain("big.h");
  });

  it("indexes a previously oversized file once it shrinks below the limit", async () => {
    await createFile(repoDir, "shrinking.h", "x".repeat(200));

    await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
      maxFileSizeBytes: 10,
    });

    await writeFile(join(repoDir, "shrinking.h"), "small");

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
      maxFileSizeBytes: 10,
    });

    expect(result.indexed).toContain("shrinking.h");
    expect(result.oversized).not.toContain("shrinking.h");
  });

  it("force=true does not override maxFileSizeBytes", async () => {
    await createFile(repoDir, "big.h", "x".repeat(200));

    const result = await indexCodebase(embedder, store, pool, repoDir, {
      metaPath,
      ttlDays: 3650,
      maxFileSizeBytes: 10,
      force: true,
    });

    expect(result.oversized).toContain("big.h");
    expect(result.indexed).not.toContain("big.h");
  });

  // ── error propagation ────────────────────────────────────────────────────────

  it("throws when repoPath is not a git repository", async () => {
    const nonGitDir = await mkdtemp(join(tmpdir(), "non-git-"));
    try {
      await expect(
        indexCodebase(embedder, store, pool, nonGitDir, { metaPath, ttlDays: 3650 }),
      ).rejects.toThrow();
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  // ── .ai-coding-ignore discovery-time exclusion ───────────────────────────────

  describe(".ai-coding-ignore", () => {
    it("excludes matched files from vectorization and reporting", async () => {
      await createFile(repoDir, ".ai-coding-ignore", "vendor/\n");
      await createFile(repoDir, "vendor/lib.ts", "export const lib = 1;\n");
      await createFile(repoDir, "src/main.ts", "export const x = 1;\n");

      const result = await indexCodebase(embedder, store, pool, repoDir, {
        metaPath,
        ttlDays: 3650,
      });

      expect(result.indexed).toContain("src/main.ts");
      expect(result.indexed).not.toContain("vendor/lib.ts");
      expect(result.ignoredCount).toBe(1);
      expect(result.ignorePatterns).toEqual(["vendor/"]);
    });

    it("keeps ignored files out of the store entirely", async () => {
      await createFile(repoDir, ".ai-coding-ignore", "vendor/\n");
      await createFile(repoDir, "vendor/lib.ts", "export const lib = 1;\n");
      await createFile(repoDir, "src/main.ts", "export const x = 1;\n");

      const result = await indexCodebase(embedder, store, pool, repoDir, {
        metaPath,
        ttlDays: 3650,
      });

      expect(result.indexed).not.toContain("vendor/lib.ts");
      expect(await store.countRows()).toBeGreaterThan(0);
    });

    it("hard-aborts with TotalExclusionError when everything is excluded, leaving the DB untouched", async () => {
      await createFile(repoDir, ".ai-coding-ignore", "*\n");
      await createFile(repoDir, "src/main.ts", "export const x = 1;\n");

      await expect(
        indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 }),
      ).rejects.toBeInstanceOf(TotalExclusionError);

      // Store was never opened, so its underlying table doesn't even exist yet.
      expect(await store.open(DIMS).then(() => store.countRows())).toBe(0);
    });

    it("does not throw TotalExclusionError for a genuinely empty repo", async () => {
      const result = await indexCodebase(embedder, store, pool, repoDir, {
        metaPath,
        ttlDays: 3650,
      });

      expect(result.indexed).toHaveLength(0);
    });

    it("composes --exclude globs onto the .ai-coding-ignore matcher", async () => {
      await createFile(repoDir, "src/main.ts", "export const x = 1;\n");
      await createFile(repoDir, "docs/notes.log", "log content\n");

      const result = await indexCodebase(embedder, store, pool, repoDir, {
        metaPath,
        ttlDays: 3650,
        excludeGlobs: ["*.log"],
      });

      expect(result.indexed).toContain("src/main.ts");
      expect(result.indexed).not.toContain("docs/notes.log");
      expect(result.ignoredCount).toBe(1);
    });

    it("self-skips the .ai-coding-ignore and .ai-coding-keep control files themselves", async () => {
      await createFile(repoDir, ".ai-coding-ignore", "vendor/\n");
      await createFile(repoDir, ".ai-coding-keep", "vendor/\n");
      await createFile(repoDir, "src/main.ts", "export const x = 1;\n");

      const result = await indexCodebase(embedder, store, pool, repoDir, {
        metaPath,
        ttlDays: 3650,
      });

      expect(result.indexed).not.toContain(".ai-coding-ignore");
      expect(result.indexed).not.toContain(".ai-coding-keep");
      expect(result.indexed).toContain("src/main.ts");
    });

    it("removes a previously-indexed file via the delete-loop once newly matched by .ai-coding-ignore, even if it also matches .ai-coding-keep", async () => {
      await createFile(repoDir, ".ai-coding-keep", "vendor/\n");
      await createFile(repoDir, "vendor/lib.ts", "export const lib = 1;\n");
      await createFile(repoDir, "src/main.ts", "export const x = 1;\n");

      // First run: not yet ignored, so it gets indexed and stored.
      await indexCodebase(embedder, store, pool, repoDir, { metaPath, ttlDays: 3650 });
      expect(await store.countRows()).toBeGreaterThan(0);

      // Add .ai-coding-ignore matching the same file that .ai-coding-keep also matches.
      await createFile(repoDir, ".ai-coding-ignore", "vendor/\n");

      const result = await indexCodebase(embedder, store, pool, repoDir, {
        metaPath,
        ttlDays: 3650,
      });

      // Precedence: ignore > keep. The delete-loop removes it because it fell
      // out of discoveredSet, regardless of the keep-matcher.
      expect(result.deleted).toContain("vendor/lib.ts");
      const remaining = await store.countRows();
      expect(remaining).toBeGreaterThan(0);
    });
  });
});
