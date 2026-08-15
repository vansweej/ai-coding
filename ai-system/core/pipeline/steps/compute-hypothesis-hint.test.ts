import { describe, expect, it } from "bun:test";

import { computeHypothesisHint } from "./compute-hypothesis-hint";

describe("computeHypothesisHint", () => {
  it("(a) returns a non-empty hint for a uniformly-indented search block", () => {
    const search = "  foo()\n  bar()";
    const hint = computeHypothesisHint(search);
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain("2 leading whitespace character(s)");
  });

  it("(a) hint mentions indentation level for a four-space uniform indent", () => {
    const search = "    const x = 1;\n    const y = 2;";
    const hint = computeHypothesisHint(search);
    expect(hint).toContain("4 leading whitespace character(s)");
  });

  it("(a) single non-empty uniformly-indented line also produces a hint", () => {
    const search = "  only line";
    const hint = computeHypothesisHint(search);
    expect(hint.length).toBeGreaterThan(0);
  });

  it("(a) tab indentation is detected as uniform (1 character)", () => {
    const search = "\tfoo()\n\tbar()";
    const hint = computeHypothesisHint(search);
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).toContain("1 leading whitespace character(s)");
  });

  it("(b) returns empty string when indentation is non-uniform (mixed depths)", () => {
    const search = "  foo()\n    bar()";
    expect(computeHypothesisHint(search)).toBe("");
  });

  it("(b) returns empty string when some lines have no indentation", () => {
    const search = "foo()\n  bar()";
    expect(computeHypothesisHint(search)).toBe("");
  });

  it("(b) returns empty string when no lines have leading whitespace", () => {
    const search = "foo()\nbar()";
    expect(computeHypothesisHint(search)).toBe("");
  });

  it("(b) empty lines mixed in do not count toward indentation check", () => {
    // Non-empty lines have different indentation → no hint, even with blank lines interspersed
    const search = "  foo()\n\n    bar()";
    expect(computeHypothesisHint(search)).toBe("");
  });

  it("(b) empty lines mixed in do not break a uniformly-indented block", () => {
    // All non-empty lines share the same indent → hint produced
    const search = "  foo()\n\n  bar()";
    const hint = computeHypothesisHint(search);
    expect(hint.length).toBeGreaterThan(0);
  });

  it("(c) returns empty string for an empty search block without throwing", () => {
    expect(() => computeHypothesisHint("")).not.toThrow();
    expect(computeHypothesisHint("")).toBe("");
  });

  it("(c) returns empty string for a whitespace-only block without throwing", () => {
    expect(() => computeHypothesisHint("   \n  \n   ")).not.toThrow();
    expect(computeHypothesisHint("   \n  \n   ")).toBe("");
  });

  it("(c) returns empty string for a single-space-only line without throwing", () => {
    expect(() => computeHypothesisHint(" ")).not.toThrow();
    expect(computeHypothesisHint(" ")).toBe("");
  });

  it("(c) never throws on any input", () => {
    const cases = ["", "   ", "\n\n", "\t\t", "  foo\n  bar", "foo\n  bar", "  a\n    b"];
    for (const input of cases) {
      expect(() => computeHypothesisHint(input)).not.toThrow();
    }
  });
});
