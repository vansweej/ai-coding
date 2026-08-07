import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { checkAssertions, parseAssertion } from "./phase-assertions";

describe("parseAssertion", () => {
  it("parses a valid contains directive", () => {
    const result = parseAssertion("contains src/x.ts :: export const value");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        kind: "contains",
        path: "src/x.ts",
        needle: "export const value",
      });
    }
  });

  it("parses a valid not-contains directive", () => {
    const result = parseAssertion("not-contains README.md :: TODO");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kind: "not-contains", path: "README.md", needle: "TODO" });
    }
  });

  it("preserves a needle containing spaces and a later ::", () => {
    const result = parseAssertion("contains src/x.ts :: a :: b with spaces");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        kind: "contains",
        path: "src/x.ts",
        needle: "a :: b with spaces",
      });
    }
  });

  it("parses a valid exists directive", () => {
    const result = parseAssertion("exists docs/x.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kind: "exists", path: "docs/x.md" });
    }
  });

  it("parses a valid not-exists directive", () => {
    const result = parseAssertion("not-exists docs/y.md");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kind: "not-exists", path: "docs/y.md" });
    }
  });

  it("fails when the :: separator is missing on a contains spec", () => {
    const result = parseAssertion("contains src/x.ts");
    expect(result.ok).toBe(false);
  });

  it("fails on an empty path", () => {
    const result = parseAssertion("contains  :: needle");
    expect(result.ok).toBe(false);
  });

  it("fails on an empty needle", () => {
    const result = parseAssertion("contains src/x.ts :: ");
    expect(result.ok).toBe(false);
  });

  it("fails on an unknown verb", () => {
    const result = parseAssertion("matches src/x.ts :: foo");
    expect(result.ok).toBe(false);
  });
});

describe("checkAssertions", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "phase-assertions-test-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("exists passes for a written file", () => {
    writeFileSync(join(workspace, "a.txt"), "content");
    const result = checkAssertions(workspace, [{ kind: "exists", path: "a.txt" }]);
    expect(result.ok).toBe(true);
  });

  it("exists fails for a missing file", () => {
    const result = checkAssertions(workspace, [{ kind: "exists", path: "missing.txt" }]);
    expect(result.ok).toBe(false);
  });

  it("not-exists passes for a missing file", () => {
    const result = checkAssertions(workspace, [{ kind: "not-exists", path: "missing.txt" }]);
    expect(result.ok).toBe(true);
  });

  it("not-exists fails for a present file", () => {
    writeFileSync(join(workspace, "a.txt"), "content");
    const result = checkAssertions(workspace, [{ kind: "not-exists", path: "a.txt" }]);
    expect(result.ok).toBe(false);
  });

  it("contains passes when content includes the needle", () => {
    writeFileSync(join(workspace, "a.txt"), "hello world");
    const result = checkAssertions(workspace, [
      { kind: "contains", path: "a.txt", needle: "world" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("contains fails when content does not include the needle", () => {
    writeFileSync(join(workspace, "a.txt"), "hello world");
    const result = checkAssertions(workspace, [
      { kind: "contains", path: "a.txt", needle: "goodbye" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("a.txt");
    }
  });

  it("contains fails on a missing file (read failure surfaced, no throw)", () => {
    const result = checkAssertions(workspace, [
      { kind: "contains", path: "missing.txt", needle: "x" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("not-contains passes when the needle is absent", () => {
    writeFileSync(join(workspace, "a.txt"), "hello world");
    const result = checkAssertions(workspace, [
      { kind: "not-contains", path: "a.txt", needle: "goodbye" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("not-contains passes when the file is missing", () => {
    const result = checkAssertions(workspace, [
      { kind: "not-contains", path: "missing.txt", needle: "x" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("not-contains fails when the needle is present", () => {
    writeFileSync(join(workspace, "a.txt"), "hello world");
    const result = checkAssertions(workspace, [
      { kind: "not-contains", path: "a.txt", needle: "world" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("returns ok:true when every assertion passes", () => {
    mkdirSync(join(workspace, "docs"), { recursive: true });
    writeFileSync(join(workspace, "a.txt"), "hello world");
    writeFileSync(join(workspace, "docs", "x.md"), "doc");
    const result = checkAssertions(workspace, [
      { kind: "contains", path: "a.txt", needle: "hello" },
      { kind: "exists", path: "docs/x.md" },
      { kind: "not-exists", path: "docs/y.md" },
      { kind: "not-contains", path: "a.txt", needle: "goodbye" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("short-circuits and names the offending path on a first-violation in the middle", () => {
    writeFileSync(join(workspace, "a.txt"), "hello world");
    const result = checkAssertions(workspace, [
      { kind: "exists", path: "a.txt" },
      { kind: "contains", path: "a.txt", needle: "goodbye" },
      { kind: "exists", path: "never-checked.txt" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("a.txt");
    }
  });
});
