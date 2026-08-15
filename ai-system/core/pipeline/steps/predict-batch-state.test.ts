import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PatchEdit } from "./parse-patch";
import {
  createBatchStatePredictor,
  predictBatchStates,
  resolveInWorkspace,
} from "./predict-batch-state";

describe("resolveInWorkspace", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join("/tmp", "predict-batch-state-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves an in-workspace relative path to the joined absolute path", () => {
    expect(resolveInWorkspace(tempDir, "a.txt")).toBe(join(tempDir, "a.txt"));
  });

  it("returns undefined for an absolute path", () => {
    expect(resolveInWorkspace(tempDir, "/etc/passwd")).toBeUndefined();
  });

  it("returns undefined for a ../-escaping relative path", () => {
    expect(resolveInWorkspace(tempDir, "../escape.txt")).toBeUndefined();
  });

  it("resolves the workspace root itself to the root", () => {
    expect(resolveInWorkspace(tempDir, ".")).toBe(tempDir);
  });
});

describe("createBatchStatePredictor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join("/tmp", "predict-batch-state-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("MOVE rule: dest predicts source content, source predicts null", () => {
    writeFileSync(join(tempDir, "a"), "X", "utf8");
    const predictor = createBatchStatePredictor(tempDir);
    const edit: PatchEdit = {
      filePath: "a",
      toPath: "b",
      search: "",
      replace: "",
      isCreate: false,
      isMove: true,
    };

    predictor.record(edit);

    expect(predictor.predictedContentOf(join(tempDir, "b"))).toBe("X");
    expect(predictor.predictedContentOf(join(tempDir, "a"))).toBeNull();
  });

  it("MOVE rule with an out-of-workspace endpoint leaves the prediction map untouched", () => {
    writeFileSync(join(tempDir, "a"), "X", "utf8");
    const predictor = createBatchStatePredictor(tempDir);
    const edit: PatchEdit = {
      filePath: "a",
      toPath: "/etc/passwd",
      search: "",
      replace: "",
      isCreate: false,
      isMove: true,
    };

    predictor.record(edit);

    expect(predictor.predictedContentOf(join(tempDir, "a"))).toBe("X");
  });

  it("CREATE rule: predictedContentOf returns the create's replace", () => {
    const predictor = createBatchStatePredictor(tempDir);
    const edit: PatchEdit = {
      filePath: "c",
      search: "",
      replace: "NEW",
      isCreate: true,
      isMove: false,
    };

    predictor.record(edit);

    expect(predictor.predictedContentOf(join(tempDir, "c"))).toBe("NEW");
  });

  it("coerced-replace rule: predictedContentOf returns the edit's replace", () => {
    const predictor = createBatchStatePredictor(tempDir);
    const edit: PatchEdit = {
      filePath: "d",
      search: "OLD",
      replace: "NEW",
      isCreate: false,
      isMove: false,
      wholeFileReplace: true,
    };

    predictor.record(edit);

    expect(predictor.predictedContentOf(join(tempDir, "d"))).toBe("NEW");
  });

  it("plain partial edit: predictedContentOf is unchanged", () => {
    writeFileSync(join(tempDir, "e"), "DISK", "utf8");
    const predictor = createBatchStatePredictor(tempDir);
    const edit: PatchEdit = {
      filePath: "e",
      search: "DISK",
      replace: "OTHER",
      isCreate: false,
      isMove: false,
    };

    predictor.record(edit);

    expect(predictor.predictedContentOf(join(tempDir, "e"))).toBe("DISK");
  });

  it("predicted-absent path (no map entry, not on disk) returns null", () => {
    const predictor = createBatchStatePredictor(tempDir);

    expect(predictor.predictedContentOf(join(tempDir, "nope"))).toBeNull();
  });

  it("map-first-no-reread: seeded value survives deletion of the backing disk file", () => {
    const filePath = join(tempDir, "f");
    writeFileSync(filePath, "ORIGINAL", "utf8");
    const predictor = createBatchStatePredictor(tempDir);
    const edit: PatchEdit = {
      filePath: "f",
      search: "",
      replace: "SEEDED",
      isCreate: true,
      isMove: false,
    };

    predictor.record(edit);
    unlinkSync(filePath);

    expect(predictor.predictedContentOf(filePath)).toBe("SEEDED");
  });
});

describe("predictBatchStates", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join("/tmp", "predict-batch-state-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("yields moved source content, pre-edit, for a subsequent edit on the moved dest", () => {
    writeFileSync(join(tempDir, "a"), "X", "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "a",
        toPath: "b",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
      },
      {
        filePath: "b",
        search: "X",
        replace: "Y",
        isCreate: false,
        isMove: false,
      },
    ];

    const yielded = [...predictBatchStates(tempDir, edits)];

    expect(yielded).toHaveLength(2);
    expect(yielded[1]?.predictedContentForFilePath).toBe("X");
  });
});

describe("predictBatchStates (simulatePartialEdits)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join("/tmp", "predict-batch-state-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("default off: a later edit sees ORIGINAL on-disk bytes (coerceCreatesToEdits unchanged)", () => {
    writeFileSync(join(tempDir, "a"), "hello world", "utf8");
    const edits: PatchEdit[] = [
      { filePath: "a", search: "hello", replace: "goodbye", isCreate: false, isMove: false },
      { filePath: "a", search: "world", replace: "there", isCreate: false, isMove: false },
    ];

    const yielded = [...predictBatchStates(tempDir, edits)];

    expect(yielded[1]?.predictedContentForFilePath).toBe("hello world");
  });

  it("on, single literal match: a later edit sees the post-replace predicted content", () => {
    writeFileSync(join(tempDir, "a"), "hello world", "utf8");
    const edits: PatchEdit[] = [
      { filePath: "a", search: "hello", replace: "goodbye", isCreate: false, isMove: false },
      { filePath: "a", search: "world", replace: "there", isCreate: false, isMove: false },
    ];

    const yielded = [...predictBatchStates(tempDir, edits, { simulatePartialEdits: true })];

    expect(yielded[1]?.predictedContentForFilePath).toBe("goodbye world");
  });

  it("on, zero matches: prediction left as original bytes", () => {
    writeFileSync(join(tempDir, "a"), "hello world", "utf8");
    const edits: PatchEdit[] = [
      { filePath: "a", search: "nope", replace: "x", isCreate: false, isMove: false },
      { filePath: "a", search: "world", replace: "there", isCreate: false, isMove: false },
    ];

    const yielded = [...predictBatchStates(tempDir, edits, { simulatePartialEdits: true })];

    expect(yielded[1]?.predictedContentForFilePath).toBe("hello world");
  });

  it("on, two-or-more matches: prediction left as original bytes", () => {
    writeFileSync(join(tempDir, "a"), "aa bb aa", "utf8");
    const edits: PatchEdit[] = [
      { filePath: "a", search: "aa", replace: "zz", isCreate: false, isMove: false },
      { filePath: "a", search: "bb", replace: "cc", isCreate: false, isMove: false },
    ];

    const yielded = [...predictBatchStates(tempDir, edits, { simulatePartialEdits: true })];

    expect(yielded[1]?.predictedContentForFilePath).toBe("aa bb aa");
  });

  it("on, M4 bare-header self-skip: a single-occurrence bare-header search does NOT mutate the prediction", () => {
    writeFileSync(join(tempDir, "Cargo.toml"), '[lints.clippy]\npedantic = "warn"', "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]",
        isCreate: false,
        isMove: false,
      },
      {
        filePath: "Cargo.toml",
        search: "pedantic",
        replace: "other",
        isCreate: false,
        isMove: false,
      },
    ];

    const yielded = [...predictBatchStates(tempDir, edits, { simulatePartialEdits: true })];

    expect(yielded[1]?.predictedContentForFilePath).toBe('[lints.clippy]\npedantic = "warn"');
  });

  it("$& safety: a replace containing '$&' is inserted literally", () => {
    writeFileSync(join(tempDir, "a"), "hello world", "utf8");
    const edits: PatchEdit[] = [
      { filePath: "a", search: "hello", replace: "$&$&", isCreate: false, isMove: false },
      { filePath: "a", search: "world", replace: "there", isCreate: false, isMove: false },
    ];

    const yielded = [...predictBatchStates(tempDir, edits, { simulatePartialEdits: true })];

    expect(yielded[1]?.predictedContentForFilePath).toBe("$&$& world");
  });
});
