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
});
