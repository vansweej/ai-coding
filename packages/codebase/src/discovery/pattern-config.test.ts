import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IGNORE_FILE, KEEP_FILE, loadMatcher, readPatterns } from "./pattern-config";

describe("loadMatcher", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pattern-config-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the control file is absent and no extraGlobs given", async () => {
    expect(await loadMatcher(tmpDir, IGNORE_FILE)).toBeNull();
  });

  it("returns null when the control file exists but is empty", async () => {
    await Bun.write(join(tmpDir, IGNORE_FILE), "\n\n");
    expect(await loadMatcher(tmpDir, IGNORE_FILE)).toBeNull();
  });

  it("loads simple patterns from the control file", async () => {
    await Bun.write(join(tmpDir, IGNORE_FILE), "vendor/\n*.log\n");
    const matcher = await loadMatcher(tmpDir, IGNORE_FILE);

    expect(matcher).not.toBeNull();
    expect(matcher?.ignores("vendor/lib.ts")).toBe(true);
    expect(matcher?.ignores("app.log")).toBe(true);
    expect(matcher?.ignores("src/main.ts")).toBe(false);
  });

  it("supports ** glob patterns", async () => {
    await Bun.write(join(tmpDir, IGNORE_FILE), "**/generated/**\n");
    const matcher = await loadMatcher(tmpDir, IGNORE_FILE);

    expect(matcher?.ignores("src/generated/foo.ts")).toBe(true);
    expect(matcher?.ignores("a/b/generated/c/d.ts")).toBe(true);
    expect(matcher?.ignores("src/main.ts")).toBe(false);
  });

  it("supports dir-only patterns with a trailing slash", async () => {
    await Bun.write(join(tmpDir, IGNORE_FILE), "foo/\n");
    const matcher = await loadMatcher(tmpDir, IGNORE_FILE);

    expect(matcher?.ignores("foo/bar.ts")).toBe(true);
    expect(matcher?.ignores("barfoo/baz.ts")).toBe(false);
  });

  it("supports ! negation to re-include a file under an ignored dir", async () => {
    await Bun.write(join(tmpDir, IGNORE_FILE), "vendor/*\n!vendor/keep.ts\n");
    const matcher = await loadMatcher(tmpDir, IGNORE_FILE);

    expect(matcher?.ignores("vendor/other.ts")).toBe(true);
    expect(matcher?.ignores("vendor/keep.ts")).toBe(false);
  });

  it("ignores comment lines and blank lines", async () => {
    await Bun.write(join(tmpDir, IGNORE_FILE), "# comment\n\nvendor/\n  \n");
    const matcher = await loadMatcher(tmpDir, IGNORE_FILE);

    expect(matcher?.ignores("vendor/lib.ts")).toBe(true);
  });

  it("composes extraGlobs (e.g. --exclude) with file patterns", async () => {
    await Bun.write(join(tmpDir, IGNORE_FILE), "vendor/\n");
    const matcher = await loadMatcher(tmpDir, IGNORE_FILE, ["*.log"]);

    expect(matcher?.ignores("vendor/lib.ts")).toBe(true);
    expect(matcher?.ignores("app.log")).toBe(true);
  });

  it("builds a matcher from extraGlobs alone when the file is absent", async () => {
    const matcher = await loadMatcher(tmpDir, IGNORE_FILE, ["*.log"]);

    expect(matcher).not.toBeNull();
    expect(matcher?.ignores("app.log")).toBe(true);
    expect(matcher?.ignores("src/main.ts")).toBe(false);
  });

  it("works identically for the KEEP_FILE filename", async () => {
    await Bun.write(join(tmpDir, KEEP_FILE), "GeometricTools/\n");
    const matcher = await loadMatcher(tmpDir, KEEP_FILE);

    expect(matcher?.ignores("GeometricTools/a.h")).toBe(true);
  });
});

describe("readPatterns", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pattern-config-read-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty array when the file is absent and no extraGlobs given", async () => {
    expect(await readPatterns(tmpDir, IGNORE_FILE)).toEqual([]);
  });

  it("returns trimmed, non-empty, non-comment lines", async () => {
    await Bun.write(join(tmpDir, IGNORE_FILE), "# comment\n\nvendor/\n  *.log  \n");
    expect(await readPatterns(tmpDir, IGNORE_FILE)).toEqual(["vendor/", "*.log"]);
  });

  it("appends extraGlobs after file patterns", async () => {
    await Bun.write(join(tmpDir, IGNORE_FILE), "vendor/\n");
    expect(await readPatterns(tmpDir, IGNORE_FILE, ["*.log"])).toEqual(["vendor/", "*.log"]);
  });
});
