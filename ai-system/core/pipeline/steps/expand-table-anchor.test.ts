import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { coerceCreatesToEdits } from "./coerce-create-to-edit";
import { expandTableHeaderAnchors } from "./expand-table-anchor";
import type { PatchEdit } from "./parse-patch";

describe("expandTableHeaderAnchors", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join("/tmp", "expand-table-anchor-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("expands the core defect case bounded by EOF", () => {
    writeFileSync(
      join(tempDir, "Cargo.toml"),
      '[package]\nname = "foo"\n\n[lints.clippy]\npedantic = "warn"\nmodule_name_repetitions = "allow"\nmust_use_candidate = "allow"\n',
      "utf8",
    );
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]?.search).toBe(
      '[lints.clippy]\npedantic = "warn"\nmodule_name_repetitions = "allow"\nmust_use_candidate = "allow"',
    );
    expect(result[0]?.isCreate).toBe(false);
    expect(result[0]?.isMove).toBe(false);
  });

  it("bounds expansion at a following [dependencies] header", () => {
    writeFileSync(
      join(tempDir, "Cargo.toml"),
      '[package]\nname = "foo"\n\n[lints.clippy]\npedantic = "warn"\n\n[dependencies]\nserde = "1"\n',
      "utf8",
    );
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]?.search).toBe('[lints.clippy]\npedantic = "warn"\n');
  });

  it("bounds expansion at a following [[bin]] header", () => {
    writeFileSync(
      join(tempDir, "Cargo.toml"),
      '[package]\nname = "foo"\n\n[lints.clippy]\npedantic = "warn"\n\n[[bin]]\nname = "foo"\n',
      "utf8",
    );
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]?.search).toBe('[lints.clippy]\npedantic = "warn"\n');
  });

  it("passes through a bare-header search whose replace is not a header", () => {
    writeFileSync(join(tempDir, "Cargo.toml"), '[lints.clippy]\npedantic = "warn"\n', "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "not-a-header content",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through an already-correct full-block search unchanged", () => {
    writeFileSync(join(tempDir, "Cargo.toml"), '[lints.clippy]\npedantic = "warn"\n', "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: '[lints.clippy]\npedantic = "warn"',
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    // search doesn't full-match the bare-header gate regex (multi-line) so
    // passes through unchanged.
    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through unchanged when the header appears zero times", () => {
    writeFileSync(join(tempDir, "Cargo.toml"), '[package]\nname = "foo"\n', "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through unchanged when the header appears multiple times", () => {
    writeFileSync(
      join(tempDir, "Cargo.toml"),
      "[lints.clippy]\na = 1\n\n[lints.clippy]\nb = 2\n",
      "utf8",
    );
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through unchanged when the path is absolute", () => {
    const edits: PatchEdit[] = [
      {
        filePath: "/etc/somewhere/Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through unchanged when the path resolves outside the workspace", () => {
    const edits: PatchEdit[] = [
      {
        filePath: "../outside/Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through unchanged when the file is missing", () => {
    const edits: PatchEdit[] = [
      {
        filePath: "does-not-exist.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]).toEqual(edits[0]);
  });

  it("expands a header at EOF to EOF", () => {
    writeFileSync(join(tempDir, "Cargo.toml"), '[package]\nname = "foo"\n\n[lints.clippy]', "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]?.search).toBe("[lints.clippy]");
  });

  it("passes through a coerced whole-file multi-line search unchanged", () => {
    writeFileSync(join(tempDir, "Cargo.toml"), '[package]\nname = "foo"\n', "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: '[package]\nname = "foo"\n',
        replace: '[package]\nname = "bar"\n',
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]).toEqual(edits[0]);
  });

  it("passes through create and move edits unchanged", () => {
    const edits: PatchEdit[] = [
      {
        filePath: "new.toml",
        search: "",
        replace: "[lints]\nworkspace = true",
        isCreate: true,
        isMove: false,
      },
      {
        filePath: "old.toml",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
        toPath: "new2.toml",
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result).toEqual(edits);
  });

  it("does not false-positive on a substring match, only a full line match", () => {
    writeFileSync(
      join(tempDir, "Cargo.toml"),
      'not[lints.clippy]not\n[lints.clippy]\npedantic = "warn"\n',
      "utf8",
    );
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]?.search).toBe('[lints.clippy]\npedantic = "warn"');
  });

  it("leaves a same-header append edit untouched (replace-vs-append discriminator)", () => {
    writeFileSync(join(tempDir, "Cargo.toml"), '[lints.clippy]\npedantic = "warn"\n', "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints.clippy]\nfoo = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]).toEqual(edits[0]);
  });

  it("does not stop expansion at a multi-line array value line resembling a header", () => {
    writeFileSync(
      join(tempDir, "Cargo.toml"),
      '[lints.clippy]\nmatrix = [\n  [1, 2],\n  [3, 4],\n]\n\n[dependencies]\nserde = "1"\n',
      "utf8",
    );
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]?.search).toBe("[lints.clippy]\nmatrix = [\n  [1, 2],\n  [3, 4],\n]\n");
  });

  it("includes descendant sub-tables when expanding a parent anchor", () => {
    writeFileSync(
      join(tempDir, "Cargo.toml"),
      '[lints]\nworkspace = true\n\n[lints.clippy]\npedantic = "warn"\n\n[dependencies]\nserde = "1"\n',
      "utf8",
    );
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints]",
        replace: "[project.lints]\nworkspace = false",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]?.search).toBe(
      '[lints]\nworkspace = true\n\n[lints.clippy]\npedantic = "warn"\n',
    );
  });

  it("still expands the defect case correctly when unrelated headers follow", () => {
    writeFileSync(
      join(tempDir, "Cargo.toml"),
      '[lints.clippy]\npedantic = "warn"\n\n[dependencies]\nserde = "1"\n\n[[bin]]\nname = "foo"\n',
      "utf8",
    );
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]?.search).toBe('[lints.clippy]\npedantic = "warn"\n');
  });

  it("preserves the trailing empty split element out of expandedSearch when the file ends in a newline", () => {
    writeFileSync(join(tempDir, "Cargo.toml"), '[lints.clippy]\npedantic = "warn"\n', "utf8");
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]?.search.endsWith("\n")).toBe(false);
    expect(result[0]?.search).toBe('[lints.clippy]\npedantic = "warn"');
  });

  it("passes through unchanged when reading the file throws (directory at target path)", () => {
    mkdirSync(join(tempDir, "Cargo.toml"));
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result[0]).toEqual(edits[0]);
  });
});

describe("expandTableHeaderAnchors (batch-aware predicted-state fold)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join("/tmp", "expand-table-anchor-batch-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("expands a narrow [lints.clippy] anchor against MOVED content when a preceding in-batch move produces the target", () => {
    writeFileSync(
      join(tempDir, "Cargo.toml"),
      '[package]\nname = "parlang"\n\n[lints.clippy]\npedantic = "warn"\nmodule_name_repetitions = "allow"\nmust_use_candidate = "allow"\n',
      "utf8",
    );
    const edits: PatchEdit[] = [
      {
        filePath: "Cargo.toml",
        toPath: "crates/parlang/Cargo.toml",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
      },
      {
        filePath: "crates/parlang/Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result).toHaveLength(2);
    expect(result[1]?.search).toContain("pedantic");
    expect(result[1]?.search).toContain("module_name_repetitions");
    expect(result[1]?.search).toContain("must_use_candidate");
    expect(result[1]?.search).not.toBe("[lints.clippy]");
  });

  it("passes a table-header edit through unchanged when its target is absent and no in-batch op produces it", () => {
    const edits: PatchEdit[] = [
      {
        filePath: "nonexistent/Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(edits[0]);
  });

  it("uses created content, not move-source content, for a coerced-create-then-edit on the same dest", () => {
    writeFileSync(join(tempDir, "old-source.toml"), '[lints.clippy]\nstale = "yes"\n', "utf8");

    const rawEdits: PatchEdit[] = [
      {
        filePath: "old-source.toml",
        toPath: "crates/parlang/Cargo.toml",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
      },
      {
        filePath: "crates/parlang/Cargo.toml",
        search: "",
        replace:
          '[package]\nname = "parlang"\n\n[lints.clippy]\npedantic = "warn"\nfresh = "yes"\n',
        isCreate: true,
        isMove: false,
      },
      {
        filePath: "crates/parlang/Cargo.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const coerced = coerceCreatesToEdits(tempDir, rawEdits);
    const result = expandTableHeaderAnchors(tempDir, coerced);

    const lastEdit = result[result.length - 1];
    expect(lastEdit?.search).toContain("pedantic");
    expect(lastEdit?.search).toContain("fresh");
    expect(lastEdit?.search).not.toContain("stale");
  });

  it("continue-discipline: a second file's edit later in the batch still applies", () => {
    writeFileSync(
      join(tempDir, "a.toml"),
      '[package]\nname = "a"\n\n[lints.clippy]\npedantic = "warn"\n',
      "utf8",
    );
    mkdirSync(join(tempDir, "sub"), { recursive: true });
    writeFileSync(
      join(tempDir, "sub", "c.toml"),
      '[package]\nname = "c"\n\n[lints.clippy]\nunused = "allow"\n',
      "utf8",
    );

    const edits: PatchEdit[] = [
      {
        filePath: "a.toml",
        toPath: "b.toml",
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
      },
      {
        filePath: "b.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
      {
        filePath: "sub/c.toml",
        search: "[lints.clippy]",
        replace: "[lints]\nworkspace = true",
        isCreate: false,
        isMove: false,
      },
    ];

    const result = expandTableHeaderAnchors(tempDir, edits);

    expect(result).toHaveLength(3);
    expect(result[1]?.search).toContain("pedantic");
    expect(result[2]?.search).toContain("unused");
  });
});
