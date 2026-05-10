import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Embedder, EmbeddingResult } from "@ai-coding/embeddings";

import { LanceStore } from "../store/lance-store";
import { indexSkills } from "./index-skills";

// ── mock embedder ─────────────────────────────────────────────────────────────

const DIMS = 4;

class MockEmbedder implements Embedder {
  readonly dimensions = Promise.resolve(DIMS);

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text]);
    const first = results[0];
    if (first === undefined) throw new Error("embedBatch returned empty array");
    return first;
  }

  async embedBatch(texts: readonly string[]): Promise<readonly EmbeddingResult[]> {
    return texts.map((_, i) => ({
      vector: new Float32Array([i * 0.1, i * 0.2, i * 0.3, i * 0.4]),
    }));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function makeSkillRoot(tmpDir: string, skills: Record<string, string>): Promise<string> {
  const root = join(tmpDir, "skills");
  await mkdir(root, { recursive: true });
  for (const [name, content] of Object.entries(skills)) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), content, "utf8");
  }
  return root;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("indexSkills", () => {
  let tmpDir: string;
  let store: LanceStore;
  let embedder: MockEmbedder;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "index-skills-test-"));
    store = new LanceStore(join(tmpDir, "skills.lance"));
    embedder = new MockEmbedder();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("indexes all skills found in the skill root", async () => {
    const root = await makeSkillRoot(tmpDir, {
      programmer: "# Programmer\n\n## Rules\n\nWrite clean code.",
      debugger: "# Debugger\n\n## Rules\n\nTrace errors carefully.",
    });
    const metaPath = join(tmpDir, "meta.json");

    const result = await indexSkills(embedder, store, root, metaPath);

    expect(result.indexed).toContain("programmer");
    expect(result.indexed).toContain("debugger");
    expect(result.skipped).toHaveLength(0);
  });

  it("stores chunks in LanceDB after indexing", async () => {
    const root = await makeSkillRoot(tmpDir, {
      programmer: "# Programmer\n\n## Rules\n\nWrite clean code.",
    });
    const metaPath = join(tmpDir, "meta.json");

    await indexSkills(embedder, store, root, metaPath);

    expect(await store.countRows()).toBeGreaterThan(0);
  });

  it("writes a .meta.json file after indexing", async () => {
    const root = await makeSkillRoot(tmpDir, {
      programmer: "# Programmer\n\nContent.",
    });
    const metaPath = join(tmpDir, "meta.json");

    await indexSkills(embedder, store, root, metaPath);

    const metaFile = Bun.file(metaPath);
    expect(await metaFile.exists()).toBe(true);
    const meta = await metaFile.json();
    expect(meta).toHaveProperty("lastIndexedAt");
    expect(meta).toHaveProperty("skillHashes.programmer");
  });

  it("skips unchanged skills on subsequent runs", async () => {
    const root = await makeSkillRoot(tmpDir, {
      programmer: "# Programmer\n\nContent.",
    });
    const metaPath = join(tmpDir, "meta.json");

    await indexSkills(embedder, store, root, metaPath);
    const result2 = await indexSkills(embedder, store, root, metaPath);

    expect(result2.skipped).toContain("programmer");
    expect(result2.indexed).toHaveLength(0);
  });

  it("re-indexes a skill when its content changes", async () => {
    const root = await makeSkillRoot(tmpDir, {
      programmer: "# Programmer\n\nOriginal content.",
    });
    const metaPath = join(tmpDir, "meta.json");

    await indexSkills(embedder, store, root, metaPath);

    // Update the skill content
    await writeFile(
      join(root, "programmer", "SKILL.md"),
      "# Programmer\n\nUpdated content.",
      "utf8",
    );

    const result2 = await indexSkills(embedder, store, root, metaPath);
    expect(result2.indexed).toContain("programmer");
    expect(result2.skipped).toHaveLength(0);
  });

  it("force=true re-indexes all skills regardless of hash", async () => {
    const root = await makeSkillRoot(tmpDir, {
      programmer: "# Programmer\n\nContent.",
    });
    const metaPath = join(tmpDir, "meta.json");

    await indexSkills(embedder, store, root, metaPath);
    const result2 = await indexSkills(embedder, store, root, metaPath, true);

    expect(result2.indexed).toContain("programmer");
    expect(result2.skipped).toHaveLength(0);
  });

  it("returns empty arrays when skill root does not exist", async () => {
    const metaPath = join(tmpDir, "meta.json");
    const result = await indexSkills(embedder, store, "/nonexistent/path", metaPath);
    expect(result.indexed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });

  it("skips skill directories that have no SKILL.md", async () => {
    const root = join(tmpDir, "skills");
    await mkdir(join(root, "empty-skill"), { recursive: true });
    const metaPath = join(tmpDir, "meta.json");

    const result = await indexSkills(embedder, store, root, metaPath);
    expect(result.indexed).toHaveLength(0);
  });

  it("handles corrupted meta.json gracefully (treats as missing)", async () => {
    const root = await makeSkillRoot(tmpDir, {
      programmer: "# Programmer\n\nContent.",
    });
    const metaPath = join(tmpDir, "meta.json");
    await writeFile(metaPath, "{ not valid json }", "utf8");

    const result = await indexSkills(embedder, store, root, metaPath);
    expect(result.indexed).toContain("programmer");
  });
});
