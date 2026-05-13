import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KEEP_MARKER, discoverFiles, discoverKeepDirs, resolveFilePath } from "./discover-files";

// ── helpers ───────────────────────────────────────────────────────────────────

async function initGitRepo(dir: string): Promise<void> {
  const run = (args: string[]) =>
    Bun.spawn(args, { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;
  await run(["git", "init"]);
  await run(["git", "config", "user.email", "test@test.com"]);
  await run(["git", "config", "user.name", "Test"]);
}

async function gitAdd(dir: string, ...files: string[]): Promise<void> {
  await Bun.spawn(["git", "add", ...files], { cwd: dir, stdout: "pipe", stderr: "pipe" }).exited;
}

async function createFile(dir: string, relativePath: string, content = ""): Promise<void> {
  const full = join(dir, relativePath);
  await mkdir(full.split("/").slice(0, -1).join("/"), { recursive: true });
  await writeFile(full, content);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("discoverFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await (async () => {
      const base = join(tmpdir(), "discover-files-test-");
      const dir = base + Math.random().toString(36).slice(2);
      await mkdir(dir, { recursive: true });
      return dir;
    })();
    await initGitRepo(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns tracked TypeScript files", async () => {
    await createFile(tmpDir, "src/main.ts", "export const x = 1;");
    await gitAdd(tmpDir, "src/main.ts");
    const files = await discoverFiles(tmpDir);
    expect(files).toContain("src/main.ts");
  });

  it("returns multiple files across directories", async () => {
    await createFile(tmpDir, "src/a.ts");
    await createFile(tmpDir, "lib/b.rs");
    await gitAdd(tmpDir, "src/a.ts", "lib/b.rs");
    const files = await discoverFiles(tmpDir);
    expect(files).toContain("src/a.ts");
    expect(files).toContain("lib/b.rs");
  });

  it("excludes .wasm files", async () => {
    await createFile(tmpDir, "grammars/tree-sitter-rust.wasm");
    await gitAdd(tmpDir, "grammars/tree-sitter-rust.wasm");
    const files = await discoverFiles(tmpDir);
    expect(files).not.toContain("grammars/tree-sitter-rust.wasm");
  });

  it("excludes image files", async () => {
    await createFile(tmpDir, "assets/logo.png");
    await gitAdd(tmpDir, "assets/logo.png");
    const files = await discoverFiles(tmpDir);
    expect(files).not.toContain("assets/logo.png");
  });

  it("excludes bun.lock", async () => {
    await createFile(tmpDir, "bun.lock");
    await gitAdd(tmpDir, "bun.lock");
    const files = await discoverFiles(tmpDir);
    expect(files).not.toContain("bun.lock");
  });

  it("excludes Cargo.lock", async () => {
    await createFile(tmpDir, "Cargo.lock");
    await gitAdd(tmpDir, "Cargo.lock");
    const files = await discoverFiles(tmpDir);
    expect(files).not.toContain("Cargo.lock");
  });

  it("excludes flake.lock", async () => {
    await createFile(tmpDir, "flake.lock");
    await gitAdd(tmpDir, "flake.lock");
    const files = await discoverFiles(tmpDir);
    expect(files).not.toContain("flake.lock");
  });

  it("returns an empty array for a repo with no tracked files", async () => {
    const files = await discoverFiles(tmpDir);
    expect(files).toHaveLength(0);
  });

  it("includes .nix files (uses fallback chunker, still indexed)", async () => {
    await createFile(tmpDir, "flake.nix");
    await gitAdd(tmpDir, "flake.nix");
    const files = await discoverFiles(tmpDir);
    expect(files).toContain("flake.nix");
  });

  it("includes .md files (uses fallback chunker, still indexed)", async () => {
    await createFile(tmpDir, "README.md");
    await gitAdd(tmpDir, "README.md");
    const files = await discoverFiles(tmpDir);
    expect(files).toContain("README.md");
  });

  it("excludes .binary files (GTE terrain heightmaps)", async () => {
    await createFile(tmpDir, "Data/height.0.0.binary");
    await gitAdd(tmpDir, "Data/height.0.0.binary");
    const files = await discoverFiles(tmpDir);
    expect(files).not.toContain("Data/height.0.0.binary");
  });

  it("excludes .sln files (Visual Studio solutions)", async () => {
    await createFile(tmpDir, "MyProject.sln");
    await gitAdd(tmpDir, "MyProject.sln");
    const files = await discoverFiles(tmpDir);
    expect(files).not.toContain("MyProject.sln");
  });

  it("excludes .vcxproj files (Visual Studio projects)", async () => {
    await createFile(tmpDir, "MyProject.vcxproj");
    await gitAdd(tmpDir, "MyProject.vcxproj");
    const files = await discoverFiles(tmpDir);
    expect(files).not.toContain("MyProject.vcxproj");
  });

  it("excludes .vcxproj.filters files (compound extension)", async () => {
    await createFile(tmpDir, "MyProject.vcxproj.filters");
    await gitAdd(tmpDir, "MyProject.vcxproj.filters");
    const files = await discoverFiles(tmpDir);
    expect(files).not.toContain("MyProject.vcxproj.filters");
  });

  it("excludes .natvis files (VS debugger visualizers)", async () => {
    await createFile(tmpDir, "gtengine.natvis");
    await gitAdd(tmpDir, "gtengine.natvis");
    const files = await discoverFiles(tmpDir);
    expect(files).not.toContain("gtengine.natvis");
  });

  it("still includes .hlsl shader files", async () => {
    await createFile(tmpDir, "Shaders/terrain.vs.hlsl", "// hlsl shader");
    await gitAdd(tmpDir, "Shaders/terrain.vs.hlsl");
    const files = await discoverFiles(tmpDir);
    expect(files).toContain("Shaders/terrain.vs.hlsl");
  });

  it("still includes .glsl shader files", async () => {
    await createFile(tmpDir, "Shaders/terrain.ps.glsl", "// glsl shader");
    await gitAdd(tmpDir, "Shaders/terrain.ps.glsl");
    const files = await discoverFiles(tmpDir);
    expect(files).toContain("Shaders/terrain.ps.glsl");
  });

  it("throws when called on a non-git directory", async () => {
    // Must be a directory outside any git repo — not a child of tmpDir (which is
    // itself a git repo). Create an isolated temp directory in the system temp root.
    const nonGitDir = await mkdtemp(join(tmpdir(), "discover-files-nongit-"));
    try {
      await expect(discoverFiles(nonGitDir)).rejects.toThrow("git ls-files failed");
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });
});

describe("resolveFilePath", () => {
  it("joins repoRoot and relativePath", () => {
    expect(resolveFilePath("/home/dev/myrepo", "src/main.ts")).toBe("/home/dev/myrepo/src/main.ts");
  });
});

describe("discoverKeepDirs", () => {
  it("returns the containing directory for a keep marker", () => {
    const dirs = discoverKeepDirs(["GeometricTools/.ai-coding-keep", "src/main.ts"]);

    expect(dirs).toEqual(["GeometricTools/"]);
  });

  it("returns directories at multiple depths sorted by path", () => {
    const dirs = discoverKeepDirs([
      "vendor/lib/.ai-coding-keep",
      "src/main.ts",
      "GeometricTools/.ai-coding-keep",
    ]);

    expect(dirs).toEqual(["GeometricTools/", "vendor/lib/"]);
  });

  it("deduplicates multiple markers for the same directory", () => {
    const dirs = discoverKeepDirs([
      "vendor/.ai-coding-keep",
      "vendor/lib.ts",
      "vendor/.ai-coding-keep",
    ]);

    expect(dirs).toEqual(["vendor/"]);
  });

  it("returns an empty array when no markers are present", () => {
    expect(discoverKeepDirs(["src/main.ts", "README.md"])).toEqual([]);
  });

  it("warns and ignores a root-level keep marker", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      expect(discoverKeepDirs([KEEP_MARKER, "src/main.ts"])).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
