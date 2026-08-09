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
      wholeFileReplace: true,
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

  it("tags a coerced edit with wholeFileReplace: true and leaves a genuine create untagged", () => {
    writeFileSync(join(tempDir, "tagged.ts"), "old content", "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "tagged.ts",
        search: "",
        replace: "new content",
        isCreate: true,
        isMove: false,
      },
      { filePath: "fresh.ts", search: "", replace: "FRESH", isCreate: true, isMove: false },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result[0]?.wholeFileReplace).toBe(true);
    expect(result[1]?.wholeFileReplace).toBeUndefined();
  });

  it("never throws and returns a new array instance", () => {
    const edits: PatchEdit[] = [
      { filePath: "a.ts", search: "", replace: "x", isCreate: true, isMove: false },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).not.toBe(edits);
  });
});

/**
 * Batch-aware in-order coercion regression tests (finding 151af9e0).
 *
 * `coerceCreatesToEdits` must simulate the predicted post-op filesystem
 * state of touched paths as it walks a whole-phase batch in order, so a
 * `create` whose target is produced (non-empty) by a preceding in-batch
 * `move`/`create` is deterministically coerced to a clean whole-file-replace
 * edit instead of passing through and hitting "already exists; cannot
 * create" at apply time.
 */
describe("coerceCreatesToEdits (in-batch predictions, finding 151af9e0)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join("/tmp", "coerce-batch-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("coerces an in-batch move→create over a produced NON-EMPTY file into a whole-file-replace edit", () => {
    writeFileSync(join(tempDir, "a.txt"), "OLD", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "a.txt",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "b.txt",
      },
      { filePath: "b.txt", search: "", replace: "NEW", isCreate: true, isMove: false },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(2);
    // The move is passed through unchanged.
    expect(result[0]).toEqual(edits[0]);
    // The create is coerced using the predicted content "OLD" left behind by the move.
    expect(result[1]).toEqual({
      filePath: "b.txt",
      search: "OLD",
      replace: "NEW",
      isCreate: false,
      isMove: false,
      wholeFileReplace: true,
    });
  });

  it("passes an in-batch move→create over a produced EMPTY file through as a create", () => {
    writeFileSync(join(tempDir, "a.txt"), "", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "a.txt",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "b.txt",
      },
      { filePath: "b.txt", search: "", replace: "NEW", isCreate: true, isMove: false },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(edits[0]);
    // The applier's empty-file relaxation handles the 0-byte existing target.
    expect(result[1]?.isCreate).toBe(true);
    expect(result[1]?.search).toBe("");
    expect(result[1]?.replace).toBe("NEW");
  });

  it("still coerces a create over an already-on-disk NON-EMPTY file (no move)", () => {
    writeFileSync(join(tempDir, "c.txt"), "OLD", "utf8");

    const edits: PatchEdit[] = [
      { filePath: "c.txt", search: "", replace: "NEW", isCreate: true, isMove: false },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      filePath: "c.txt",
      search: "OLD",
      replace: "NEW",
      isCreate: false,
      isMove: false,
      wholeFileReplace: true,
    });
  });

  it("passes a genuine new-file create through unchanged", () => {
    const edits: PatchEdit[] = [
      { filePath: "new.txt", search: "", replace: "FRESH", isCreate: true, isMove: false },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edits[0]);
  });

  it("passes a byte-identical in-batch produced create through unchanged (apply would be a no-op)", () => {
    writeFileSync(join(tempDir, "a.txt"), "SAME", "utf8");

    const edits: PatchEdit[] = [
      {
        filePath: "a.txt",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "b.txt",
      },
      { filePath: "b.txt", search: "", replace: "SAME", isCreate: true, isMove: false },
    ];

    const result = coerceCreatesToEdits(tempDir, edits);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(edits[0]);
    expect(result[1]).toEqual(edits[1]);
    expect(result[1]?.isCreate).toBe(true);
  });
});
