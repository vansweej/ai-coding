import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coerceCreatesToEdits } from "./coerce-create-to-edit";
import type { PatchEdit } from "./parse-patch";

describe("coerceCreatesToEdits", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join("/tmp", "coerce-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes through a create targeting a non-existent path unchanged", () => {
    const edits: PatchEdit[] = [
      { filePath: "new-file.ts", search: "", replace: "content", isCreate: true, isMove: false },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edits[0]);
  });

  it("coerces a create targeting an existing non-empty file with different contents into a whole-file-replace edit", () => {
    writeFileSync(join(tempDir, "existing.ts"), "old content", "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "existing.ts",
        search: "",
        replace: "new content",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filePath: "existing.ts",
      search: "old content",
      replace: "new content",
      isCreate: false,
      isMove: false,
    });
  });

  it("passes through a create targeting an existing file with byte-identical contents unchanged", () => {
    writeFileSync(join(tempDir, "same.ts"), "same content", "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "same.ts",
        search: "",
        replace: "same content",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through a create targeting an existing EMPTY file as a create, not an empty-search edit", () => {
    writeFileSync(join(tempDir, "empty.ts"), "", "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "empty.ts",
        search: "",
        replace: "new content",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]?.isCreate).toBe(true);
    expect(result[0]?.search).toBe("");
    expect(result[0]?.replace).toBe("new content");
  });

  it("passes through a create with an out-of-workspace filePath unchanged without reading the filesystem", () => {
    const edits: PatchEdit[] = [
      {
        filePath: "../escape.txt",
        search: "",
        replace: "malicious",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through a create with an absolute filePath unchanged without reading the filesystem", () => {
    const edits: PatchEdit[] = [
      {
        filePath: "/etc/passwd",
        search: "",
        replace: "malicious",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through a plain edit op unchanged", () => {
    const edits: PatchEdit[] = [
      {
        filePath: "file.ts",
        search: "foo",
        replace: "bar",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through a move op unchanged", () => {
    const edits: PatchEdit[] = [
      {
        filePath: "src/old.ts",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "src/new.ts",
      },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edits[0]);
  });

  it("coerces a create over a repeated-pattern file so the whole-file search matches exactly once (non-overlapping)", () => {
    writeFileSync(join(tempDir, "repeated.ts"), "abab", "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "repeated.ts",
        search: "",
        replace: "cdcd",
        isCreate: true,
        isMove: false,
      },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]?.isCreate).toBe(false);
    expect(result[0]?.search).toBe("abab");
    expect(result[0]?.replace).toBe("cdcd");
  });

  it("never throws and returns a new array instance", () => {
    const edits: PatchEdit[] = [
      { filePath: "a.ts", search: "", replace: "x", isCreate: true, isMove: false },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).not.toBe(edits);
  });
});
