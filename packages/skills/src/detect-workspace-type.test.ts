import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectWorkspaceType } from "./detect-workspace-type";

const TMP_DIR = "/tmp/opencode/detect-workspace-type-tests";

function makeDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function makeFile(path: string): void {
  writeFileSync(path, "");
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

describe("detectWorkspaceType", () => {
  beforeEach(() => makeDir(TMP_DIR));
  afterEach(() => cleanup(TMP_DIR));

  it("returns 'unknown' when workspace is undefined", async () => {
    expect(await detectWorkspaceType(undefined)).toBe("unknown");
  });

  it("returns 'rust' when Cargo.toml exists", async () => {
    makeFile(join(TMP_DIR, "Cargo.toml"));
    expect(await detectWorkspaceType(TMP_DIR)).toBe("rust");
  });

  it("returns 'cpp' when CMakeLists.txt exists", async () => {
    makeFile(join(TMP_DIR, "CMakeLists.txt"));
    expect(await detectWorkspaceType(TMP_DIR)).toBe("cpp");
  });

  it("returns 'typescript' when package.json exists", async () => {
    makeFile(join(TMP_DIR, "package.json"));
    expect(await detectWorkspaceType(TMP_DIR)).toBe("typescript");
  });

  it("returns 'unknown' when no marker files exist", async () => {
    expect(await detectWorkspaceType(TMP_DIR)).toBe("unknown");
  });

  it("prefers 'rust' over 'cpp' when both markers exist", async () => {
    makeFile(join(TMP_DIR, "Cargo.toml"));
    makeFile(join(TMP_DIR, "CMakeLists.txt"));
    expect(await detectWorkspaceType(TMP_DIR)).toBe("rust");
  });

  it("prefers 'rust' over 'typescript' when both markers exist", async () => {
    makeFile(join(TMP_DIR, "Cargo.toml"));
    makeFile(join(TMP_DIR, "package.json"));
    expect(await detectWorkspaceType(TMP_DIR)).toBe("rust");
  });

  it("prefers 'cpp' over 'typescript' when both markers exist", async () => {
    makeFile(join(TMP_DIR, "CMakeLists.txt"));
    makeFile(join(TMP_DIR, "package.json"));
    expect(await detectWorkspaceType(TMP_DIR)).toBe("cpp");
  });

  it("returns 'unknown' for a non-existent directory", async () => {
    expect(await detectWorkspaceType("/tmp/opencode/does-not-exist-xyz")).toBe("unknown");
  });
});
