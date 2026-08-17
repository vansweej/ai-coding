import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  classifyRoute,
  hasMappedButUnavailableTouchedFile,
  route,
} from "../../ai-system/core/pipeline/routing/route";

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "classify-route-test-"));
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  return dir;
}

describe("classifyRoute", () => {
  it("returns 'unmapped' for .md, .toml, .json, and no-extension paths", () => {
    expect(classifyRoute("README.md", new Set())).toBe("unmapped");
    expect(classifyRoute("Cargo.toml", new Set(["cargo"]))).toBe("unmapped");
    expect(classifyRoute("package.json", new Set(["bun"]))).toBe("unmapped");
    expect(classifyRoute("Makefile", new Set(["cargo"]))).toBe("unmapped");
  });

  it("returns 'mapped-unavailable' for .rs when cargo is absent from the palette", () => {
    expect(classifyRoute("src/lib.rs", new Set(["bun"]))).toBe("mapped-unavailable");
  });

  it("returns 'routed' for .rs when cargo is present", () => {
    expect(classifyRoute("src/lib.rs", new Set(["cargo"]))).toBe("routed");
  });

  it("returns 'routed' for .ts when bun is present", () => {
    expect(classifyRoute("src/index.ts", new Set(["bun"]))).toBe("routed");
  });

  it("returns 'mapped-unavailable' for .ts with an empty palette", () => {
    expect(classifyRoute("src/index.ts", new Set())).toBe("mapped-unavailable");
  });
});

describe("route() reimplementation equivalence", () => {
  it("returns the descriptor exactly when classifyRoute is 'routed'", () => {
    expect(route("src/lib.rs", new Set(["cargo"]))?.id).toBe("rust");
    expect(classifyRoute("src/lib.rs", new Set(["cargo"]))).toBe("routed");
  });

  it("returns null when classifyRoute is 'mapped-unavailable'", () => {
    expect(route("src/lib.rs", new Set(["bun"]))).toBeNull();
    expect(classifyRoute("src/lib.rs", new Set(["bun"]))).toBe("mapped-unavailable");
  });

  it("returns null when classifyRoute is 'unmapped'", () => {
    expect(route("README.md", new Set(["cargo"]))).toBeNull();
    expect(classifyRoute("README.md", new Set(["cargo"]))).toBe("unmapped");
  });
});

describe("hasMappedButUnavailableTouchedFile", () => {
  it("returns hit:true with the filePath and toolchain when a touched .rs file's toolchain is unavailable", () => {
    const dir = makeTempGitRepo();
    try {
      writeFileSync(join(dir, "a.rs"), "// initial\n");
      execSync("git add -A", { cwd: dir });
      execSync('git commit -q -m "initial"', { cwd: dir });
      writeFileSync(join(dir, "a.rs"), "// modified\n");

      const result = hasMappedButUnavailableTouchedFile(dir, new Set());
      expect(result.hit).toBe(true);
      if (result.hit) {
        expect(result.filePath).toBe("a.rs");
        expect(result.toolchain).toBe("rust");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns hit:false when only an unmapped .md file is touched", () => {
    const dir = makeTempGitRepo();
    try {
      writeFileSync(join(dir, "README.md"), "# initial\n");
      execSync("git add -A", { cwd: dir });
      execSync('git commit -q -m "initial"', { cwd: dir });
      writeFileSync(join(dir, "README.md"), "# modified\n");

      const result = hasMappedButUnavailableTouchedFile(dir, new Set());
      expect(result.hit).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns hit:false when the touched .rs file's toolchain is available", () => {
    const dir = makeTempGitRepo();
    try {
      writeFileSync(join(dir, "a.rs"), "// initial\n");
      execSync("git add -A", { cwd: dir });
      execSync('git commit -q -m "initial"', { cwd: dir });
      writeFileSync(join(dir, "a.rs"), "// modified\n");

      const result = hasMappedButUnavailableTouchedFile(dir, new Set(["cargo"]));
      expect(result.hit).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
