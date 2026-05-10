import { describe, expect, it } from "bun:test";
import type { Node as SyntaxNode, Tree } from "web-tree-sitter";

import { extractChunks } from "./node-extractors";

// ── mock helpers ──────────────────────────────────────────────────────────────

/**
 * Minimal fake SyntaxNode that satisfies the shape required by extractChunks.
 *
 * Only the properties actually accessed by the function are included:
 *   type, startPosition, endPosition, startIndex, endIndex, children,
 *   text (for name fields only), firstNamedChild, childForFieldName.
 */
function fakeNode(params: {
  type: string;
  text?: string;
  startRow?: number;
  endRow?: number;
  startIndex?: number;
  endIndex?: number;
  children?: SyntaxNode[];
  /** Field-name → node mapping for childForFieldName() */
  fields?: Record<string, SyntaxNode | null>;
  firstNamedChild?: SyntaxNode | null;
}): SyntaxNode {
  return {
    type: params.type,
    text: params.text ?? "",
    startPosition: { row: params.startRow ?? 0, column: 0 },
    endPosition: { row: params.endRow ?? 0, column: 0 },
    startIndex: params.startIndex ?? 0,
    endIndex: params.endIndex ?? params.text?.length ?? 10,
    children: params.children ?? [],
    firstNamedChild: params.firstNamedChild ?? null,
    childForFieldName: (name: string) => params.fields?.[name] ?? null,
  } as unknown as SyntaxNode;
}

/** Build a fake Tree whose rootNode.children are the supplied nodes. */
function fakeTree(children: SyntaxNode[]): Tree {
  const root = fakeNode({
    type: "program",
    children,
    startIndex: 0,
    endIndex: 9999,
  });
  return { rootNode: root } as unknown as Tree;
}

// ── constants ─────────────────────────────────────────────────────────────────

const REPO_ID = "/home/dev/myrepo";
const FILE_PATH = "src/main.ts";

// ── test suites ───────────────────────────────────────────────────────────────

describe("extractChunks — unknown language", () => {
  it("returns empty array for a language not in CHUNK_NODES", () => {
    const tree = fakeTree([]);
    expect(extractChunks(tree, "", REPO_ID, FILE_PATH, "nix")).toHaveLength(0);
  });

  it("returns empty array when language string is empty", () => {
    const tree = fakeTree([]);
    expect(extractChunks(tree, "", REPO_ID, FILE_PATH, "")).toHaveLength(0);
  });
});

describe("extractChunks — no matching nodes", () => {
  it("returns empty array when root has no children matching CHUNK_NODES", () => {
    const tree = fakeTree([fakeNode({ type: "comment", startIndex: 0, endIndex: 5 })]);
    expect(extractChunks(tree, "// hi\n", REPO_ID, FILE_PATH, "typescript")).toHaveLength(0);
  });
});

describe("extractChunks — TypeScript", () => {
  it("emits one chunk per function_declaration", () => {
    const source = "function hello() {}\n\nfunction world() {}\n";
    const tree = fakeTree([
      fakeNode({
        type: "function_declaration",
        startIndex: 0,
        endIndex: 19,
        startRow: 0,
        endRow: 0,
        fields: { name: fakeNode({ type: "identifier", text: "hello" }) },
      }),
      fakeNode({
        type: "function_declaration",
        startIndex: 21,
        endIndex: 40,
        startRow: 2,
        endRow: 2,
        fields: { name: fakeNode({ type: "identifier", text: "world" }) },
      }),
    ]);

    const chunks = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    expect(chunks).toHaveLength(2);
  });

  it("sets symbolName from the 'name' field", () => {
    const source = "function hello() {}";
    const tree = fakeTree([
      fakeNode({
        type: "function_declaration",
        startIndex: 0,
        endIndex: source.length,
        fields: { name: fakeNode({ type: "identifier", text: "hello" }) },
      }),
    ]);

    const [chunk] = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    expect(chunk?.symbolName).toBe("hello");
  });

  it("sets symbolName to null when no name/declarator/pattern field exists", () => {
    const source = "export default 42;";
    const tree = fakeTree([
      fakeNode({
        type: "export_statement",
        startIndex: 0,
        endIndex: source.length,
        // no fields → childForFieldName returns null
      }),
    ]);

    const [chunk] = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    expect(chunk?.symbolName).toBeNull();
  });

  it("sets symbolKind to the raw AST node type", () => {
    const source = "class Foo {}";
    const tree = fakeTree([
      fakeNode({
        type: "class_declaration",
        startIndex: 0,
        endIndex: source.length,
        fields: { name: fakeNode({ type: "identifier", text: "Foo" }) },
      }),
    ]);

    const [chunk] = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    expect(chunk?.symbolKind).toBe("class_declaration");
  });

  it("sets repoId and filePath on each chunk", () => {
    const source = "const x = 1;";
    const tree = fakeTree([
      fakeNode({ type: "lexical_declaration", startIndex: 0, endIndex: source.length }),
    ]);

    const [chunk] = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    expect(chunk?.repoId).toBe(REPO_ID);
    expect(chunk?.filePath).toBe(FILE_PATH);
  });

  it("assigns sequential chunkIndex values starting at 0", () => {
    const source = "function a(){}\nfunction b(){}\nfunction c(){}";
    const nodes = ["a", "b", "c"].map((name, i) =>
      fakeNode({
        type: "function_declaration",
        startIndex: i * 15,
        endIndex: i * 15 + 14,
        fields: { name: fakeNode({ type: "identifier", text: name }) },
      }),
    );

    const chunks = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    const tree2 = fakeTree(nodes);
    const chunks2 = extractChunks(tree2, source, REPO_ID, FILE_PATH, "typescript");

    expect(chunks2.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
  });

  it("startLine and endLine are 1-based (row 0 → line 1)", () => {
    const source = "function hello() {}";
    const tree = fakeTree([
      fakeNode({
        type: "function_declaration",
        startRow: 0,
        endRow: 2,
        startIndex: 0,
        endIndex: source.length,
        fields: { name: fakeNode({ type: "identifier", text: "hello" }) },
      }),
    ]);

    const [chunk] = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    expect(chunk?.startLine).toBe(1); // row 0 + 1
    expect(chunk?.endLine).toBe(3); // row 2 + 1
  });

  it("includes a context prefix in the chunk text", () => {
    const source = "function greet() {}";
    const tree = fakeTree([
      fakeNode({
        type: "function_declaration",
        startIndex: 0,
        endIndex: source.length,
        fields: { name: fakeNode({ type: "identifier", text: "greet" }) },
      }),
    ]);

    const [chunk] = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    expect(chunk?.text).toContain(`# file: ${FILE_PATH}`);
    expect(chunk?.text).toContain("greet");
  });

  it("prefix strips trailing 'declaration' from kind label", () => {
    const source = "function myFn() {}";
    const tree = fakeTree([
      fakeNode({
        type: "function_declaration",
        startIndex: 0,
        endIndex: source.length,
        fields: { name: fakeNode({ type: "identifier", text: "myFn" }) },
      }),
    ]);

    const [chunk] = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    // Kind label should be "function" (not "function declaration")
    expect(chunk?.text).toContain("| function: myFn");
  });

  it("prefix omits symbol name when symbolName is null", () => {
    const source = 'import "x";';
    const tree = fakeTree([
      fakeNode({
        type: "import_statement",
        startIndex: 0,
        endIndex: source.length,
      }),
    ]);

    const [chunk] = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    expect(chunk?.text).toMatch(/# file: src\/main\.ts \| import statement$/m);
  });

  it("raw source text is embedded in the chunk", () => {
    const source = "const MY_CONST = 42;";
    const tree = fakeTree([
      fakeNode({
        type: "lexical_declaration",
        startIndex: 0,
        endIndex: source.length,
      }),
    ]);

    const [chunk] = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    expect(chunk?.text).toContain(source);
  });
});

describe("extractChunks — container node recursion", () => {
  it("recurses into source_file container nodes", () => {
    const source = "function inner() {}";
    // Wrap the function inside a source_file container
    const innerNode = fakeNode({
      type: "function_declaration",
      startIndex: 0,
      endIndex: source.length,
      fields: { name: fakeNode({ type: "identifier", text: "inner" }) },
    });
    const container = fakeNode({
      type: "source_file",
      children: [innerNode],
      startIndex: 0,
      endIndex: source.length,
    });

    const tree = fakeTree([container]);
    const chunks = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.symbolName).toBe("inner");
  });

  it("recurses into translation_unit container nodes (C/C++)", () => {
    const source = "int foo() { return 0; }";
    const innerNode = fakeNode({
      type: "function_definition",
      startIndex: 0,
      endIndex: source.length,
      fields: { declarator: fakeNode({ type: "identifier", text: "foo" }) },
    });
    const container = fakeNode({
      type: "translation_unit",
      children: [innerNode],
      startIndex: 0,
      endIndex: source.length,
    });

    const tree = fakeTree([container]);
    const chunks = extractChunks(tree, source, REPO_ID, FILE_PATH, "c");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.symbolName).toBe("foo");
  });

  it("does not recurse into non-container, non-chunk nodes", () => {
    const source = "// comment\nfunction ok() {}";
    const comment = fakeNode({ type: "comment", startIndex: 0, endIndex: 10 });
    const fn = fakeNode({
      type: "function_declaration",
      startIndex: 11,
      endIndex: source.length,
      fields: { name: fakeNode({ type: "identifier", text: "ok" }) },
    });

    const tree = fakeTree([comment, fn]);
    const chunks = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript");
    // comment is ignored; function_declaration is collected
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.symbolName).toBe("ok");
  });
});

describe("extractChunks — declarator field (C/C++ function names)", () => {
  it("extracts name from a function_declarator child", () => {
    const source = "int compute(int x) { return x; }";
    const nameId = fakeNode({ type: "identifier", text: "compute" });
    const funcDeclarator = fakeNode({
      type: "function_declarator",
      fields: { declarator: nameId },
      firstNamedChild: nameId,
    });
    const funcDef = fakeNode({
      type: "function_definition",
      startIndex: 0,
      endIndex: source.length,
      fields: { declarator: funcDeclarator },
    });

    const tree = fakeTree([funcDef]);
    const chunks = extractChunks(tree, source, REPO_ID, FILE_PATH, "c");
    expect(chunks[0]?.symbolName).toBe("compute");
  });

  it("falls back to firstNamedChild when function_declarator has no declarator field", () => {
    const source = "int helper() {}";
    const nameId = fakeNode({ type: "identifier", text: "helper" });
    const funcDeclarator = fakeNode({
      type: "function_declarator",
      firstNamedChild: nameId,
      // no "declarator" field
    });
    const funcDef = fakeNode({
      type: "function_definition",
      startIndex: 0,
      endIndex: source.length,
      fields: { declarator: funcDeclarator },
    });

    const tree = fakeTree([funcDef]);
    const chunks = extractChunks(tree, source, REPO_ID, FILE_PATH, "c");
    expect(chunks[0]?.symbolName).toBe("helper");
  });
});

describe("extractChunks — Rust", () => {
  it("emits a chunk for function_item", () => {
    const source = "fn add(a: i32, b: i32) -> i32 { a + b }";
    const tree = fakeTree([
      fakeNode({
        type: "function_item",
        startIndex: 0,
        endIndex: source.length,
        fields: { name: fakeNode({ type: "identifier", text: "add" }) },
      }),
    ]);

    const chunks = extractChunks(tree, source, REPO_ID, "src/lib.rs", "rust");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.symbolName).toBe("add");
  });

  it("emits a chunk for struct_item", () => {
    const source = "struct Point { x: f32, y: f32 }";
    const tree = fakeTree([
      fakeNode({
        type: "struct_item",
        startIndex: 0,
        endIndex: source.length,
        fields: { name: fakeNode({ type: "type_identifier", text: "Point" }) },
      }),
    ]);

    const chunks = extractChunks(tree, source, REPO_ID, "src/lib.rs", "rust");
    expect(chunks[0]?.symbolName).toBe("Point");
  });
});

describe("extractChunks — oversized chunk sub-splitting", () => {
  it("splits an oversized node on blank lines", () => {
    // Build a source that is just over the custom maxChunkChars limit
    const part1 = "x".repeat(60);
    const part2 = "y".repeat(60);
    const source = `${part1}\n\n${part2}`;

    const tree = fakeTree([
      fakeNode({
        type: "function_declaration",
        startIndex: 0,
        endIndex: source.length,
        fields: { name: fakeNode({ type: "identifier", text: "big" }) },
      }),
    ]);

    // maxChunkChars = 80 so prefix + part1 alone fits, but prefix + both parts don't
    const chunks = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript", 80);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("each sub-chunk respects the maxChunkChars limit", () => {
    const longPart = "z".repeat(50);
    const source = Array.from({ length: 6 }, () => longPart).join("\n\n");

    const tree = fakeTree([
      fakeNode({
        type: "function_declaration",
        startIndex: 0,
        endIndex: source.length,
      }),
    ]);

    const chunks = extractChunks(tree, source, REPO_ID, FILE_PATH, "typescript", 80);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(80);
    }
  });
});

// Keep a local reference so the unused `tree` variable warning is suppressed
const tree = fakeTree([]);
