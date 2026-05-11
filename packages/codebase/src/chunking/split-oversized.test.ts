import { describe, expect, it } from "bun:test";

import { splitOversized } from "./split-oversized";

describe("splitOversized", () => {
  it("returns input as-is when within the limit", () => {
    const result = splitOversized("short text", 100);
    expect(result).toEqual(["short text"]);
  });

  it("splits on blank lines (tier 1)", () => {
    const part1 = "a".repeat(40);
    const part2 = "b".repeat(40);
    const text = `${part1}\n\n${part2}`;
    const result = splitOversized(text, 50);
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(50);
    }
  });

  it("accumulates small paragraphs together without splitting", () => {
    const text = "aaa\n\nbbb\n\nccc";
    const result = splitOversized(text, 100);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("aaa");
    expect(result[0]).toContain("bbb");
    expect(result[0]).toContain("ccc");
  });

  it("falls through to line splitting when a paragraph has no blank lines (tier 2)", () => {
    const line1 = "x".repeat(40);
    const line2 = "y".repeat(40);
    const text = `${line1}\n${line2}`;
    const result = splitOversized(text, 50);
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(50);
    }
  });

  it("hard-splits a single line with no newlines and no blank lines (tier 3)", () => {
    const text = "z".repeat(300);
    const result = splitOversized(text, 80);
    expect(result.length).toBeGreaterThanOrEqual(4);
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(80);
    }
  });

  it("prefers splitting at whitespace during hard split", () => {
    // 20 words of 4 chars each separated by spaces, limit = 30
    const text = Array.from({ length: 20 }, () => "word").join(" ");
    const result = splitOversized(text, 30);
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(30);
      // pieces should not start or end with a space
      expect(piece).toBe(piece.trim());
    }
  });

  it("handles minified JS — single very long line with no whitespace (tier 3)", () => {
    const text = "abcdefghij".repeat(100); // 1000 chars, no spaces or newlines
    const result = splitOversized(text, 80);
    expect(result.length).toBeGreaterThanOrEqual(13);
    for (const piece of result) {
      expect(piece.length).toBeLessThanOrEqual(80);
    }
  });

  it("every returned piece is non-empty", () => {
    const text = "a\n\n\n\nb\n\n\n\nc";
    const result = splitOversized(text, 5);
    expect(result.length).toBeGreaterThan(0);
    for (const piece of result) {
      expect(piece.trim().length).toBeGreaterThan(0);
    }
  });
});
