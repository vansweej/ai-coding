import { describe, expect, it } from "bun:test";

import { fallbackChunk } from "./fallback-chunker";

const REPO_ID = "/home/dev/myrepo";
const FILE_PATH = "flake.nix";

describe("fallbackChunk", () => {
  it("returns empty array for empty content", () => {
    expect(fallbackChunk(REPO_ID, FILE_PATH, "")).toHaveLength(0);
  });

  it("returns empty array for whitespace-only content", () => {
    expect(fallbackChunk(REPO_ID, FILE_PATH, "   \n\n\t\n")).toHaveLength(0);
  });

  it("returns a single chunk for small content", () => {
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, "let x = 1;\n");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("let x = 1;");
  });

  it("includes the file path prefix in each chunk", () => {
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, "let x = 1;\n");
    expect(chunks[0]?.text).toContain("# file: flake.nix");
  });

  it("sets symbolName and symbolKind to null", () => {
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, "let x = 1;\n");
    expect(chunks[0]?.symbolName).toBeNull();
    expect(chunks[0]?.symbolKind).toBeNull();
  });

  it("sets repoId and filePath correctly", () => {
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, "content");
    expect(chunks[0]?.repoId).toBe(REPO_ID);
    expect(chunks[0]?.filePath).toBe(FILE_PATH);
  });

  it("assigns sequential chunkIndex values", () => {
    const content = "# Section 1\ncontent\n# Section 2\ncontent";
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, content);
    const indices = chunks.map((c) => c.chunkIndex);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    const unique = new Set(indices);
    expect(unique.size).toBe(chunks.length);
  });

  it("splits on markdown headings", () => {
    const content = "# Section 1\ncontent one\n# Section 2\ncontent two";
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("splits on comment section headers", () => {
    const content = "//─── Part A ───\ncode a\n//─── Part B ───\ncode b";
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, content);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("sub-splits oversized sections on blank lines", () => {
    const paragraph = "x".repeat(2000);
    const content = `${paragraph}\n\n${paragraph}`;
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, content, 2500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("each chunk respects maxChunkChars", () => {
    const paragraph = "x".repeat(2000);
    const content = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, content, 2500);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(2500);
    }
  });

  it("records startLine and endLine", () => {
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, "line1\nline2\nline3");
    expect(chunks[0]?.startLine).toBeGreaterThanOrEqual(1);
    expect(chunks[0]?.endLine).toBeGreaterThanOrEqual(chunks[0]?.startLine ?? 0);
  });

  it("handles single-line files", () => {
    const chunks = fallbackChunk(REPO_ID, FILE_PATH, "single line");
    expect(chunks).toHaveLength(1);
  });
});
