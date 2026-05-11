import { describe, expect, it } from "bun:test";
import type { Tree } from "web-tree-sitter";

import type { ParserPool } from "./parser-pool";
import { chunkFile } from "./code-chunker";

// ── mock helpers ──────────────────────────────────────────────────────────────

/**
 * Build a minimal fake ParserPool.
 *
 * Only the three methods used by chunkFile are required:
 *   hasGrammar, getParser, grammarPath.
 */
function mockPool(opts: {
  hasGrammar?: (lang: string) => boolean;
  getParser?: (lang: string) => Promise<{ parse: (src: string) => Tree | null }>;
}): ParserPool {
  return {
    hasGrammar: opts.hasGrammar ?? (() => false),
    getParser: opts.getParser ?? (() => Promise.reject(new Error("getParser not mocked"))),
    grammarPath: (lang: string) => `/grammars/tree-sitter-${lang}.wasm`,
  } as unknown as ParserPool;
}

/**
 * Build a minimal fake Tree with no matching nodes.
 * extractChunks will return [] → chunkFile falls back.
 */
function emptyTree(): Tree {
  return {
    rootNode: {
      type: "program",
      children: [],
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: 0 },
      startIndex: 0,
      endIndex: 0,
      childForFieldName: () => null,
      firstNamedChild: null,
    },
  } as unknown as Tree;
}

/**
 * Build a fake Tree with one function_declaration child so that
 * extractChunks("typescript") returns at least one chunk.
 */
function treeWithFunction(source: string): Tree {
  return {
    rootNode: {
      type: "program",
      children: [
        {
          type: "function_declaration",
          text: source,
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: source.length },
          startIndex: 0,
          endIndex: source.length,
          children: [],
          firstNamedChild: null,
          childForFieldName: (name: string) =>
            name === "name"
              ? {
                  type: "identifier",
                  text: "myFunc",
                  childForFieldName: () => null,
                  firstNamedChild: null,
                }
              : null,
        },
      ],
      startPosition: { row: 0, column: 0 },
      endPosition: { row: 0, column: source.length },
      startIndex: 0,
      endIndex: source.length,
      childForFieldName: () => null,
      firstNamedChild: null,
    },
  } as unknown as Tree;
}

// ── constants ─────────────────────────────────────────────────────────────────

const REPO_ID = "/home/dev/myrepo";
const FILE_PATH = "src/main.ts";
const SOURCE = "function myFunc() {\n  return 42;\n}\n";

// ── tests ─────────────────────────────────────────────────────────────────────

describe("chunkFile — fallback paths", () => {
  it("uses fallback when language is null", async () => {
    const pool = mockPool({});
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, SOURCE, null);
    expect(chunks.length).toBeGreaterThan(0);
    // Fallback chunks have null symbolName/symbolKind
    expect(chunks[0]?.symbolName).toBeNull();
    expect(chunks[0]?.symbolKind).toBeNull();
  });

  it("uses fallback when grammar is not installed", async () => {
    const pool = mockPool({ hasGrammar: () => false });
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, SOURCE, "typescript");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.symbolName).toBeNull();
  });

  it("uses fallback when parser.parse() returns null", async () => {
    const pool = mockPool({
      hasGrammar: () => true,
      getParser: async () => ({ parse: () => null }),
    });
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, SOURCE, "typescript");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.symbolName).toBeNull();
  });

  it("uses fallback when getParser() throws", async () => {
    const pool = mockPool({
      hasGrammar: () => true,
      getParser: async () => {
        throw new Error("WASM load failed");
      },
    });
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, SOURCE, "typescript");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.symbolName).toBeNull();
  });

  it("uses fallback when tree-sitter produces zero chunks", async () => {
    // emptyTree has no matching nodes → extractChunks returns []
    const pool = mockPool({
      hasGrammar: () => true,
      getParser: async () => ({ parse: () => emptyTree() }),
    });
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, SOURCE, "typescript");
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.symbolName).toBeNull();
  });

  it("returns empty array for empty source via fallback", async () => {
    const pool = mockPool({});
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, "", null);
    expect(chunks).toHaveLength(0);
  });
});

describe("chunkFile — tree-sitter path", () => {
  it("uses tree-sitter chunks when grammar is available and produces matches", async () => {
    const pool = mockPool({
      hasGrammar: () => true,
      getParser: async () => ({ parse: (src: string) => treeWithFunction(src) }),
    });
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, SOURCE, "typescript");
    expect(chunks.length).toBeGreaterThan(0);
    // Tree-sitter chunk has symbolName set
    expect(chunks[0]?.symbolName).toBe("myFunc");
  });

  it("tree-sitter chunks contain the file path", async () => {
    const pool = mockPool({
      hasGrammar: () => true,
      getParser: async () => ({ parse: (src: string) => treeWithFunction(src) }),
    });
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, SOURCE, "typescript");
    expect(chunks[0]?.filePath).toBe(FILE_PATH);
  });

  it("tree-sitter chunks contain the repoId", async () => {
    const pool = mockPool({
      hasGrammar: () => true,
      getParser: async () => ({ parse: (src: string) => treeWithFunction(src) }),
    });
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, SOURCE, "typescript");
    expect(chunks[0]?.repoId).toBe(REPO_ID);
  });

  it("chunk text contains the context prefix", async () => {
    const pool = mockPool({
      hasGrammar: () => true,
      getParser: async () => ({ parse: (src: string) => treeWithFunction(src) }),
    });
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, SOURCE, "typescript");
    expect(chunks[0]?.text).toContain(`# file: ${FILE_PATH}`);
  });
});

describe("chunkFile — metadata", () => {
  it("all chunks have repoId and filePath set correctly", async () => {
    const pool = mockPool({});
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, SOURCE, null);
    for (const chunk of chunks) {
      expect(chunk.repoId).toBe(REPO_ID);
      expect(chunk.filePath).toBe(FILE_PATH);
    }
  });

  it("chunkIndex values are unique and sequential starting at 0", async () => {
    const multi = "line 1\n\nline 2\n\nline 3\n\nline 4\n\nline 5\n";
    const pool = mockPool({});
    const chunks = await chunkFile(pool, REPO_ID, FILE_PATH, multi, null);
    const indices = chunks.map((c) => c.chunkIndex);
    expect(indices).toEqual([...Array(chunks.length).keys()]);
  });
});
