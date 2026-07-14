import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    const filePath = join(tempDir, "src/nested/deep/file.ts");
    const content = readFileSync(filePath, "utf8");
    expect(content).toBe("export const value = 42;");
  });

  it("fails when creating a file that already exists", async () => {
    // Setup: create a file
    const filePath = join(tempDir, "existing.ts");
    writeFileSync(filePath, "old content", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "existing.ts",
        search: "",
        replace: "new content",
        isCreate: true,
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.reason).toBe("exists");
    expect(result.error.message).toContain("already exists");
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
      },
      {
        filePath: "b.ts",
        search: "old b",
        replace: "new b",
        isCreate: false,
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
      },
      {
        filePath: "nonexistent.ts",
        search: "old",
        replace: "new",
        isCreate: false,
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
      },
    ];

    const result = await applyPatch(tempDir, edits);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    const content = readFileSync(filePath, "utf8");
    expect(content).toBe("const pattern = /[0-9]+/;");
  });
});
