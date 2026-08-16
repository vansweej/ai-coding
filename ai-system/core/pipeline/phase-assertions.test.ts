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
    const result = parseAssertion("bogus src/x.ts :: foo");
    expect(result.ok).toBe(false);
  });

  it("parses a valid matches directive", () => {
    const result = parseAssertion("matches src/foo.ts :: ^export");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kind: "matches", path: "src/foo.ts", pattern: "^export" });
    }
  });

  it("fails when the :: separator is missing on a matches spec", () => {
    const result = parseAssertion("matches src/foo.ts ^export");
    expect(result.ok).toBe(false);
  });

  it("fails on an empty path for a matches spec", () => {
    const result = parseAssertion("matches  :: ^export");
    expect(result.ok).toBe(false);
  });

  it("fails on an empty pattern for a matches spec", () => {
    const result = parseAssertion("matches src/foo.ts :: ");
    expect(result.ok).toBe(false);
  });

  it("fails on an invalid regex for a matches spec, without throwing", () => {
    expect(() => parseAssertion("matches src/foo.ts :: (")).not.toThrow();
    const result = parseAssertion("matches src/foo.ts :: (");
    expect(result.ok).toBe(false);
  });

  it("parses a valid single-key toml-keys directive", () => {
    const result = parseAssertion("toml-keys Cargo.toml :: lints :: workspace");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        kind: "toml-keys",
        path: "Cargo.toml",
        table: "lints",
        keys: ["workspace"],
      });
    }
  });

  it("parses a valid multi-key toml-keys directive with whitespace trimmed", () => {
    const result = parseAssertion("toml-keys Cargo.toml :: package :: name , version ,  edition");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        kind: "toml-keys",
        path: "Cargo.toml",
        table: "package",
        keys: ["name", "version", "edition"],
      });
    }
  });

  it("drops a trailing/stray comma in the keys list", () => {
    const result = parseAssertion("toml-keys Cargo.toml :: package :: name,version,");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        kind: "toml-keys",
        path: "Cargo.toml",
        table: "package",
        keys: ["name", "version"],
      });
    }
  });

  it("fails when the second :: separator is missing", () => {
    const result = parseAssertion("toml-keys Cargo.toml :: lints");
    expect(result.ok).toBe(false);
  });

  it("fails on an empty path for a toml-keys spec", () => {
    const result = parseAssertion("toml-keys  :: lints :: workspace");
    expect(result.ok).toBe(false);
  });

  it("fails on an empty table for a toml-keys spec", () => {
    const result = parseAssertion("toml-keys Cargo.toml ::  :: workspace");
    expect(result.ok).toBe(false);
  });

  it("fails on empty keys for a toml-keys spec", () => {
    const result = parseAssertion("toml-keys Cargo.toml :: lints :: ");
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

  it("exists passes for a written file", async () => {
    writeFileSync(join(workspace, "a.txt"), "content");
    const result = await checkAssertions(workspace, [{ kind: "exists", path: "a.txt" }]);
    expect(result.ok).toBe(true);
  });

  it("exists fails for a missing file", async () => {
    const result = await checkAssertions(workspace, [{ kind: "exists", path: "missing.txt" }]);
    expect(result.ok).toBe(false);
  });

  it("not-exists passes for a missing file", async () => {
    const result = await checkAssertions(workspace, [{ kind: "not-exists", path: "missing.txt" }]);
    expect(result.ok).toBe(true);
  });

  it("not-exists fails for a present file", async () => {
    writeFileSync(join(workspace, "a.txt"), "content");
    const result = await checkAssertions(workspace, [{ kind: "not-exists", path: "a.txt" }]);
    expect(result.ok).toBe(false);
  });

  it("contains passes when content includes the needle", async () => {
    writeFileSync(join(workspace, "a.txt"), "hello world");
    const result = await checkAssertions(workspace, [
      { kind: "contains", path: "a.txt", needle: "world" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("contains fails when content does not include the needle", async () => {
    writeFileSync(join(workspace, "a.txt"), "hello world");
    const result = await checkAssertions(workspace, [
      { kind: "contains", path: "a.txt", needle: "goodbye" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("a.txt");
    }
  });

  it("contains fails on a missing file (read failure surfaced, no throw)", async () => {
    const result = await checkAssertions(workspace, [
      { kind: "contains", path: "missing.txt", needle: "x" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("not-contains passes when the needle is absent", async () => {
    writeFileSync(join(workspace, "a.txt"), "hello world");
    const result = await checkAssertions(workspace, [
      { kind: "not-contains", path: "a.txt", needle: "goodbye" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("not-contains fails when the file is missing (absence cannot be proven for an unreadable file)", async () => {
    const result = await checkAssertions(workspace, [
      { kind: "not-contains", path: "missing.txt", needle: "x" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("not-contains fails when the needle is present", async () => {
    writeFileSync(join(workspace, "a.txt"), "hello world");
    const result = await checkAssertions(workspace, [
      { kind: "not-contains", path: "a.txt", needle: "world" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("returns ok:true when every assertion passes", async () => {
    mkdirSync(join(workspace, "docs"), { recursive: true });
    writeFileSync(join(workspace, "a.txt"), "hello world");
    writeFileSync(join(workspace, "docs", "x.md"), "doc");
    const result = await checkAssertions(workspace, [
      { kind: "contains", path: "a.txt", needle: "hello" },
      { kind: "exists", path: "docs/x.md" },
      { kind: "not-exists", path: "docs/y.md" },
      { kind: "not-contains", path: "a.txt", needle: "goodbye" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("short-circuits and names the offending path on a first-violation in the middle", async () => {
    writeFileSync(join(workspace, "a.txt"), "hello world");
    const result = await checkAssertions(workspace, [
      { kind: "exists", path: "a.txt" },
      { kind: "contains", path: "a.txt", needle: "goodbye" },
      { kind: "exists", path: "never-checked.txt" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("a.txt");
    }
  });

  it("matches passes when content matches the pattern", async () => {
    writeFileSync(join(workspace, "a.txt"), "export const value = 1;");
    const result = await checkAssertions(workspace, [
      { kind: "matches", path: "a.txt", pattern: "^export const value" },
    ]);
    expect(result.ok).toBe(true);
  });

  it("matches fails when content does not match the pattern", async () => {
    writeFileSync(join(workspace, "a.txt"), "const value = 1;");
    const result = await checkAssertions(workspace, [
      { kind: "matches", path: "a.txt", pattern: "^export" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("matches fails on a missing/unreadable file", async () => {
    const result = await checkAssertions(workspace, [
      { kind: "matches", path: "missing.txt", pattern: "^export" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("matches fails on an invalid regex without throwing", async () => {
    writeFileSync(join(workspace, "a.txt"), "content");
    const result = await expect(checkAssertions(workspace, [{ kind: "matches", path: "a.txt", pattern: "(" }])).resolves.toBeDefined();
    const actual = await checkAssertions(workspace, [{ kind: "matches", path: "a.txt", pattern: "(" }]);
    expect(actual.ok).toBe(false);
  });

  it("toml-keys passes on an exact key-set match", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), "[lints]\nworkspace = true\n");
    const result = await checkAssertions(workspace, [
      { kind: "toml-keys", path: "Cargo.toml", table: "lints", keys: ["workspace"] },
    ]);
    expect(result.ok).toBe(true);
  });

  it("toml-keys fails on a superset of keys, naming the extra key", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), '[lints]\nworkspace = true\nextra = "oops"\n');
    const result = await checkAssertions(workspace, [
      { kind: "toml-keys", path: "Cargo.toml", table: "lints", keys: ["workspace"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("extra");
    }
  });

  it("toml-keys fails on a subset of keys", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), '[package]\nname = "x"\nversion = "1.0"\n');
    const result = await checkAssertions(workspace, [
      {
        kind: "toml-keys",
        path: "Cargo.toml",
        table: "package",
        keys: ["name", "version", "edition"],
      },
    ]);
    expect(result.ok).toBe(false);
  });

  it("toml-keys fails when the table is missing", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), '[package]\nname = "x"\n');
    const result = await checkAssertions(workspace, [
      { kind: "toml-keys", path: "Cargo.toml", table: "lints", keys: ["workspace"] },
    ]);
    expect(result.ok).toBe(false);
  });

  it("toml-keys passes for a nested dotted-table path", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), "[lints.workspace]\nfoo = true\n");
    const result = await checkAssertions(workspace, [
      { kind: "toml-keys", path: "Cargo.toml", table: "lints.workspace", keys: ["foo"] },
    ]);
    expect(result.ok).toBe(true);
  });

  it("toml-keys fails when a segment resolves to a primitive", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), "[lints]\nworkspace = true\n");
    const result = await checkAssertions(workspace, [
      { kind: "toml-keys", path: "Cargo.toml", table: "lints.workspace", keys: ["foo"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("boolean");
    }
  });

  it("toml-keys fails when a segment resolves to an array", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), '[[bin]]\nname = "x"\n');
    const result = await checkAssertions(workspace, [
      { kind: "toml-keys", path: "Cargo.toml", table: "bin", keys: ["name"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("array");
    }
  });

  it("toml-keys fails when a segment resolves to a datetime", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), "key = 1979-05-27T07:32:00Z\n");
    const result = await checkAssertions(workspace, [
      { kind: "toml-keys", path: "Cargo.toml", table: "key", keys: ["foo"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("datetime");
    }
  });

  it("toml-keys fails on an unreadable/missing file, without throwing", async () => {
    await expect(checkAssertions(workspace, [
      { kind: "toml-keys", path: "missing.toml", table: "lints", keys: ["workspace"] },
    ])).resolves.toBeDefined();
    const result = await checkAssertions(workspace, [
      { kind: "toml-keys", path: "missing.toml", table: "lints", keys: ["workspace"] },
    ]);
    expect(result.ok).toBe(false);
  });

  it("toml-keys fails on invalid TOML source, without throwing", async () => {
    writeFileSync(join(workspace, "Cargo.toml"), "this is not = = valid toml [[[");
    await expect(checkAssertions(workspace, [
      { kind: "toml-keys", path: "Cargo.toml", table: "lints", keys: ["workspace"] },
    ])).resolves.toBeDefined();
    const result = await checkAssertions(workspace, [
      { kind: "toml-keys", path: "Cargo.toml", table: "lints", keys: ["workspace"] },
    ]);
    expect(result.ok).toBe(false);
  });
});
