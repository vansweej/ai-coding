import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPatch } from "./apply-patch-step";
import type { PatchEdit } from "./parse-patch";

describe("applyPatch", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join("/tmp", "patch-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("modifies an existing file", async () => {
    // Setup: create a file with initial content
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "const x = 1;", "utf8");

    // Apply patch
    const edits: PatchEdit[] = [
      {
        filePath: "test.ts",
        search: "const x = 1;",
        replace: "const x = 2;",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.filePath).toBe("test.ts");
    expect(result.value[0]?.created).toBe(false);

    // Verify the file was modified
    const content = readFileSync(filePath, "utf8");
    expect(content).toBe("const x = 2;");
  });

  it("creates a new file", async () => {
    const edits: PatchEdit[] = [
      {
        filePath: "new-file.ts",
        search: "",
        replace: "const newCode = 'hello';",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.filePath).toBe("new-file.ts");
    expect(result.value[0]?.created).toBe(true);

    // Verify the file was created
    const filePath = join(tempDir, "new-file.ts");
    const content = readFileSync(filePath, "utf8");
    expect(content).toBe("const newCode = 'hello';");
  });

  it("creates parent directories when needed", async () => {
    const edits: PatchEdit[] = [
      {
        filePath: "src/nested/deep/file.ts",
        search: "",
        replace: "export const value = 42;",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    const filePath = join(tempDir, "src/nested/deep/file.ts");
    const content = readFileSync(filePath, "utf8");
    expect(content).toBe("export const value = 42;");
  });

  it("fails when creating a file that already exists with different content", async () => {
    // Setup: create a file
    const filePath = join(tempDir, "existing.ts");
    writeFileSync(filePath, "old content", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "existing.ts",
        search: "",
        replace: "new content",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("exists");
    expect(result.error.message).toContain("already exists");
  });

  it("treats create-mode as a no-op success when the file already has identical content", async () => {
    // Simulates a retry re-issuing an already-applied create step: a prior
    // attempt in the same phase round already wrote this exact content
    // before a later step failed, and the retry re-sends all steps combined.
    const filePath = join(tempDir, "already-created.ts");
    writeFileSync(filePath, "export const value = 1;", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "already-created.ts",
        search: "",
        replace: "export const value = 1;",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.filePath).toBe("already-created.ts");
    expect(result.value[0]?.created).toBe(false);

    // File content is unchanged.
    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;");
  });

  it("overwrites an existing EMPTY file when creating (no content to conflict with)", async () => {
    // Simulates a create op targeting a file that already exists as a
    // zero-byte placeholder (e.g. left behind by an earlier move/touch).
    // An empty file has no content to conflict with, so create is allowed
    // to overwrite it deterministically instead of declining "exists".
    const filePath = join(tempDir, "empty.ts");
    writeFileSync(filePath, "", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "empty.ts",
        search: "",
        replace: "export const value = 1;",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.filePath).toBe("empty.ts");
    expect(result.value[0]?.created).toBe(false);

    expect(readFileSync(filePath, "utf8")).toBe("export const value = 1;");
  });

  it("returns not-found when anchor is not in the file", async () => {
    // Setup: create a file
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "const x = 1;", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "test.ts",
        search: "const y = 2;",
        replace: "const y = 3;",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("not-found");
    expect(result.error.message).toContain("Search anchor not found");
    // Anchor has no leading whitespace, so no hypothesis hint is appended.
    expect(result.error.message).toBe('Search anchor not found in "test.ts"');
    expect(result.error.message).not.toContain("leading whitespace character(s)");
  });

  it("returns not-found with a hypothesis hint when the anchor is uniformly indented", async () => {
    // Setup: create a file whose content does not contain the anchor at all.
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "const x = 1;", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "test.ts",
        search: "  const y = 2;\n  const z = 3;",
        replace: "  const y = 4;\n  const z = 5;",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("not-found");
    expect(result.error.message).toContain("Search anchor not found in");
    expect(result.error.message).toContain("leading whitespace character(s)");
  });

  it("returns ambiguous when anchor appears multiple times", async () => {
    // Setup: create a file with duplicate content
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "const x = 1;\nconst x = 1;", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "test.ts",
        search: "const x = 1;",
        replace: "const x = 2;",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("ambiguous");
    expect(result.error.message).toContain("appears 2 times");
  });

  it("returns ambiguous with an indented anchor and no hypothesis hint (hint is scoped to not-found only)", async () => {
    // Setup: create a file with duplicate, uniformly-indented content.
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "  const x = 1;\n  const x = 1;", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "test.ts",
        search: "  const x = 1;",
        replace: "  const x = 2;",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("ambiguous");
    expect(result.error.message).not.toContain("leading whitespace character(s)");
  });

  it("rejects path-escape attempts via ../", async () => {
    const edits: PatchEdit[] = [
      {
        filePath: "../../../etc/passwd",
        search: "",
        replace: "hacked",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("io");
    expect(result.error.message).toContain("escapes the workspace root");
  });

  it("rejects absolute-path attacks", async () => {
    const edits: PatchEdit[] = [
      {
        filePath: "/etc/passwd",
        search: "",
        replace: "hacked",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("io");
    expect(result.error.message).toContain("must be relative");
  });

  it("handles multi-line replacements", async () => {
    // Setup: create a file
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "function old() {\n  return 1;\n}", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "test.ts",
        search: "function old() {\n  return 1;\n}",
        replace: "function new() {\n  return 2;\n}",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    const content = readFileSync(filePath, "utf8");
    expect(content).toBe("function new() {\n  return 2;\n}");
  });

  it("applies multiple edits in sequence", async () => {
    // Setup: create two files
    const file1 = join(tempDir, "a.ts");
    const file2 = join(tempDir, "b.ts");
    writeFileSync(file1, "old a", "utf8");
    writeFileSync(file2, "old b", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "a.ts",
        search: "old a",
        replace: "new a",
        isCreate: false,
        isMove: false,
      },
      {
        filePath: "b.ts",
        search: "old b",
        replace: "new b",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(2);
    expect(readFileSync(file1, "utf8")).toBe("new a");
    expect(readFileSync(file2, "utf8")).toBe("new b");
  });

  it("stops on first error and does not apply subsequent edits", async () => {
    // Setup: create one file
    const file1 = join(tempDir, "a.ts");
    writeFileSync(file1, "old a", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "a.ts",
        search: "old a",
        replace: "new a",
        isCreate: false,
        isMove: false,
      },
      {
        filePath: "nonexistent.ts",
        search: "old",
        replace: "new",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.filePath).toBe("nonexistent.ts");
    expect(result.error.reason).toBe("not-found");

    // First file should still be modified (it was applied before the error)
    expect(readFileSync(file1, "utf8")).toBe("new a");
  });

  it("handles special regex characters in search anchor", async () => {
    // Setup: create a file with regex special chars
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "const pattern = /[a-z]+/;", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "test.ts",
        search: "const pattern = /[a-z]+/;",
        replace: "const pattern = /[0-9]+/;",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    const content = readFileSync(filePath, "utf8");
    expect(content).toBe("const pattern = /[0-9]+/;");
  });

  it("moves a file", async () => {
    const oldPath = join(tempDir, "old-name.ts");
    writeFileSync(oldPath, "export const value = 1;", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "old-name.ts",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "new-name.ts",
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.filePath).toBe("new-name.ts");

    expect(existsSync(oldPath)).toBe(false);
    const newPath = join(tempDir, "new-name.ts");
    expect(existsSync(newPath)).toBe(true);
    expect(readFileSync(newPath, "utf8")).toBe("export const value = 1;");
  });

  it("moves a directory with nested files", async () => {
    const oldDir = join(tempDir, "src");
    mkdirSync(join(oldDir, "nested"), { recursive: true });
    writeFileSync(join(oldDir, "lib.ts"), "export const a = 1;", "utf8");
    writeFileSync(join(oldDir, "nested", "deep.ts"), "export const b = 2;", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "src",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "crates/parlang/src",
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(existsSync(oldDir)).toBe(false);
    const newDir = join(tempDir, "crates/parlang/src");
    expect(readFileSync(join(newDir, "lib.ts"), "utf8")).toBe("export const a = 1;");
    expect(readFileSync(join(newDir, "nested", "deep.ts"), "utf8")).toBe("export const b = 2;");
  });

  it("treats a re-issued move as a no-op success when already applied", async () => {
    // Simulates a retry re-issuing an already-applied move step (see the
    // create-mode idempotency test above for the same multi-step-retry
    // rationale): a prior attempt already relocated the file before a later
    // step failed, and the retry re-sends all steps combined.
    const newPath = join(tempDir, "new-name.ts");
    writeFileSync(newPath, "export const value = 1;", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "old-name.ts",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "new-name.ts",
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.filePath).toBe("new-name.ts");
    expect(readFileSync(newPath, "utf8")).toBe("export const value = 1;");
  });

  it("fails a move when the destination already exists and the source is still present", async () => {
    const oldPath = join(tempDir, "old-name.ts");
    const newPath = join(tempDir, "new-name.ts");
    writeFileSync(oldPath, "old content", "utf8");
    writeFileSync(newPath, "different content", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "old-name.ts",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "new-name.ts",
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("exists");
    expect(result.error.message).toContain("already exists");
    // Neither file was touched.
    expect(readFileSync(oldPath, "utf8")).toBe("old content");
    expect(readFileSync(newPath, "utf8")).toBe("different content");
  });

  it("fails a move when neither the source nor the destination exists", async () => {
    const edits: PatchEdit[] = [
      {
        filePath: "missing-source.ts",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "missing-dest.ts",
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("not-found");
    expect(result.error.filePath).toBe("missing-source.ts");
  });

  it("rejects a move whose destination escapes the workspace root via ../", async () => {
    const oldPath = join(tempDir, "old-name.ts");
    writeFileSync(oldPath, "content", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "old-name.ts",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "../../../etc/passwd",
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("io");
    expect(result.error.message).toContain("escapes the workspace root");
    // Source is untouched since the destination guard fails first.
    expect(existsSync(oldPath)).toBe(true);
  });

  // Guards against a regression of the literal-replacement fix: `applyPatch` must
  // use a replacer FUNCTION (not a string) as the second argument to
  // String.prototype.replace, so that $-substitution patterns in the model-supplied
  // replacement text (`$&`, `$1`, `$$`, `` $` ``, `$'`) land verbatim instead of being
  // interpreted specially (which would silently re-insert the matched anchor text).
  describe("literal $-pattern replacement", () => {
    it("preserves a literal $& in the replacement without re-inserting the matched anchor", async () => {
      const filePath = join(tempDir, "test.ts");
      writeFileSync(filePath, "const anchor = 1;", "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "test.ts",
          search: "const anchor = 1;",
          replace: "const anchor = '$&';",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits);
      expect(result.ok).toBe(true);

      const content = readFileSync(filePath, "utf8");
      expect(content).toBe("const anchor = '$&';");
      // The original matched anchor text must not have been re-inserted anywhere.
      expect(content).not.toContain("const anchor = 1;");
    });

    it("preserves a literal $1 in the replacement", async () => {
      const filePath = join(tempDir, "test.ts");
      writeFileSync(filePath, "const anchor = 1;", "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "test.ts",
          search: "const anchor = 1;",
          replace: "const anchor = '$1';",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits);
      expect(result.ok).toBe(true);

      const content = readFileSync(filePath, "utf8");
      expect(content).toBe("const anchor = '$1';");
    });

    it("preserves a literal $$ in the replacement without collapsing it to a single $", async () => {
      const filePath = join(tempDir, "test.ts");
      writeFileSync(filePath, "const anchor = 1;", "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "test.ts",
          search: "const anchor = 1;",
          replace: "const price = '$$5';",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits);
      expect(result.ok).toBe(true);

      const content = readFileSync(filePath, "utf8");
      expect(content).toBe("const price = '$$5';");
    });

    it("still performs a normal replacement with no $-sequences", async () => {
      const filePath = join(tempDir, "test.ts");
      writeFileSync(filePath, "const anchor = 1;", "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "test.ts",
          search: "const anchor = 1;",
          replace: "const anchor = 2;",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits);
      expect(result.ok).toBe(true);

      const content = readFileSync(filePath, "utf8");
      expect(content).toBe("const anchor = 2;");
    });
  });

  describe("options.expandTableAnchors", () => {
    it("expands a confirmed table-header rename anchor against the on-disk bytes at apply time", async () => {
      const filePath = join(tempDir, "Cargo.toml");
      const original =
        '[package]\nname = "parlang"\n\n[lints.clippy]\npedantic = "warn"\nmodule_name_repetitions = "allow"\n\n[dependencies]\nserde = "1"\n';
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search: "[lints.clippy]",
          replace: "[lints]\nworkspace = true",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, { expandTableAnchors: true });
      expect(result.ok).toBe(true);

      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("[lints]\nworkspace = true");
      expect(content).not.toContain("pedantic");
      expect(content).not.toContain("module_name_repetitions");
    });

    it("passes through an append-same-header edit unexpanded (no table-body deletion)", async () => {
      const filePath = join(tempDir, "Cargo.toml");
      const original = '[lints.clippy]\npedantic = "warn"\n\n[dependencies]\nserde = "1"\n';
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search: "[lints.clippy]",
          replace: '[lints.clippy]\nunwrap_used = "deny"',
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, { expandTableAnchors: true });
      expect(result.ok).toBe(true);

      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("pedantic");
      expect(content).toContain("unwrap_used");
    });

    it("hard-aborts with anchor-unexpandable when a confirmed rename anchor matches zero header lines on disk", async () => {
      const filePath = join(tempDir, "Cargo.toml");
      const original = '[package]\nname = "foo"\n\n[dependencies]\nserde = "1"\n';
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search: "[lints.clippy]",
          replace: "[lints]\nworkspace = true",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, { expandTableAnchors: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe("anchor-unexpandable");
      }
      expect(readFileSync(filePath, "utf8")).toBe(original);
    });

    it("hard-aborts with anchor-unexpandable when a confirmed rename anchor matches multiple header lines on disk", async () => {
      const filePath = join(tempDir, "Cargo.toml");
      const original = "[lints.clippy]\na = 1\n\n[lints.clippy] # dup\nb = 2\n";
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search: "[lints.clippy]",
          replace: "[lints]\nworkspace = true",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, { expandTableAnchors: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe("anchor-unexpandable");
      }
      expect(readFileSync(filePath, "utf8")).toBe(original);
    });

    it("does not expand when the option is disabled (default behaviour unchanged)", async () => {
      const filePath = join(tempDir, "Cargo.toml");
      const original =
        '[lints.clippy]\npedantic = "warn"\nmodule_name_repetitions = "allow"\n\n[dependencies]\nserde = "1"\n';
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search: "[lints.clippy]",
          replace: "[lints]\nworkspace = true",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits);
      expect(result.ok).toBe(true);

      const content = readFileSync(filePath, "utf8");
      // Without expansion, only the narrow header anchor is replaced --
      // the old table body is left dangling under the new header.
      expect(content).toContain("[lints]\nworkspace = true");
      expect(content).toContain("pedantic");
    });
  });

  describe("tolerantAnchorMatch option", () => {
    it("recovers a paraphrased anchor that drops comment lines (captured-bytes happy path)", async () => {
      const filePath = join(tempDir, "Cargo.toml");
      const original =
        "[lints.clippy]\n" +
        "# Enforce stricter linting for better code quality\n" +
        'pedantic = { level = "warn", priority = -1 }\n' +
        "# Allow some pedantic lints that are too strict for this project\n" +
        'module_name_repetitions = "allow"\n' +
        'must_use_candidate = "allow"\n';
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search:
            "[lints.clippy]\n" +
            'pedantic = { level = "warn", priority = -1 }\n' +
            'module_name_repetitions = "allow"\n' +
            'must_use_candidate = "allow"',
          replace: '[lints.clippy]\npedantic = "allow"',
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, { tolerantAnchorMatch: true });
      expect(result.ok).toBe(true);

      const content = readFileSync(filePath, "utf8");
      expect(content).toBe('[lints.clippy]\npedantic = "allow"\n');
    });

    it("opt-out: fails and leaves bytes unchanged when the option is not set", async () => {
      const filePath = join(tempDir, "Cargo.toml");
      const original =
        "[lints.clippy]\n" +
        "# Enforce stricter linting for better code quality\n" +
        'pedantic = { level = "warn", priority = -1 }\n' +
        "# Allow some pedantic lints that are too strict for this project\n" +
        'module_name_repetitions = "allow"\n' +
        'must_use_candidate = "allow"\n';
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search:
            "[lints.clippy]\n" +
            'pedantic = { level = "warn", priority = -1 }\n' +
            'module_name_repetitions = "allow"\n' +
            'must_use_candidate = "allow"',
          replace: '[lints.clippy]\npedantic = "allow"',
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe("not-found");
        expect(result.error.message).toContain("Search anchor not found");
      }
      expect(readFileSync(filePath, "utf8")).toBe(original);
    });

    it("dangling-following-table rejection: the region never crosses the blank line, following table survives", async () => {
      const filePath = join(tempDir, "Cargo.toml");
      const original =
        "[lints.clippy]\n" +
        "# Enforce stricter linting for better code quality\n" +
        'pedantic = { level = "warn", priority = -1 }\n' +
        "# Allow some pedantic lints that are too strict for this project\n" +
        'module_name_repetitions = "allow"\n' +
        'must_use_candidate = "allow"\n' +
        "\n" +
        "[lints.rust]\n" +
        'unsafe_code = "forbid"\n';
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search:
            "[lints.clippy]\n" +
            'pedantic = { level = "warn", priority = -1 }\n' +
            'module_name_repetitions = "allow"\n' +
            'must_use_candidate = "allow"',
          replace: '[lints.clippy]\npedantic = "allow"',
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, { tolerantAnchorMatch: true });
      expect(result.ok).toBe(true);

      const content = readFileSync(filePath, "utf8");
      expect(content).toContain('[lints.rust]\nunsafe_code = "forbid"');
      expect(content).toContain('[lints.clippy]\npedantic = "allow"');
    });

    it("zero-candidate: search first line absent leaves bytes unchanged", async () => {
      const filePath = join(tempDir, "Cargo.toml");
      const original = "[lints.clippy]\n" + 'pedantic = "warn"\n';
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search: "[completely.absent]\nfoo = 1",
          replace: "irrelevant",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, { tolerantAnchorMatch: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe("not-found");
      }
      expect(readFileSync(filePath, "utf8")).toBe(original);
    });

    it("multi-start ambiguous: two blank-separated satisfying regions leave bytes unchanged", async () => {
      const filePath = join(tempDir, "config.toml");
      const original =
        "[table]\n" +
        "# comment\n" +
        'key = "value"\n' +
        "\n" +
        "[table]\n" +
        "# another comment\n" +
        'key = "value"\n';
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "config.toml",
          search: '[table]\nkey = "value"',
          replace: "irrelevant",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, { tolerantAnchorMatch: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe("ambiguous");
      }
      expect(readFileSync(filePath, "utf8")).toBe(original);
    });

    it("end-point ambiguity: last anchor line recurs within one non-blank run leaves bytes unchanged", async () => {
      const filePath = join(tempDir, "config.toml");
      const original =
        "[table]\n" + "# comment\n" + 'flag = "allow"\n' + "# comment2\n" + 'flag = "allow"\n';
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "config.toml",
          search: '[table]\nflag = "allow"',
          replace: "irrelevant",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, { tolerantAnchorMatch: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(["ambiguous", "not-found"]).toContain(result.error.reason);
      }
      expect(readFileSync(filePath, "utf8")).toBe(original);
    });

    it("indentation-significant rejection: differing leading indentation fails closed, bytes unchanged", async () => {
      const filePath = join(tempDir, "script.py");
      const original = "if True:\n    print('hello')\n";
      writeFileSync(filePath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "script.py",
          search: "if True:\nprint('hello')",
          replace: "if True:\nprint('goodbye')",
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, { tolerantAnchorMatch: true });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe("not-found");
      }
      expect(readFileSync(filePath, "utf8")).toBe(original);
    });

    it("expander-coexistence: exactly one mutation occurs when both options are enabled", async () => {
      const filePath = join(tempDir, "Cargo.toml");
      const original =
        "[lints.clippy]\n" +
        "# Enforce stricter linting for better code quality\n" +
        'pedantic = { level = "warn", priority = -1 }\n' +
        "# Allow some pedantic lints that are too strict for this project\n" +
        'module_name_repetitions = "allow"\n' +
        'must_use_candidate = "allow"\n';
      writeFileSync(filePath, original, "utf8");

      // A multi-line, non-bare-header anchor: the table expander's bare-header
      // gate does not fire for this shape, so only the tolerant matcher can
      // recover it (against the RAW edit.search).
      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search:
            "[lints.clippy]\n" +
            'pedantic = { level = "warn", priority = -1 }\n' +
            'module_name_repetitions = "allow"\n' +
            'must_use_candidate = "allow"',
          replace: '[lints.clippy]\npedantic = "allow"',
          isCreate: false,
          isMove: false,
        },
      ];

      const result = await applyPatch(tempDir, edits, {
        expandTableAnchors: true,
        tolerantAnchorMatch: true,
      });
      expect(result.ok).toBe(true);

      const content = readFileSync(filePath, "utf8");
      // Exactly one mutation: the tolerant region replacement, not a
      // double-applied/paraphrase-stacked result.
      expect(content).toBe('[lints.clippy]\npedantic = "allow"\n');
    });
  });
});
