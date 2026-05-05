import { describe, expect, it } from "bun:test";

import { chunkSkill } from "./markdown-chunker";

// ── helpers ──────────────────────────────────────────────────────────────────

const SIMPLE_DOC = `# Programmer

## Responsibilities

Write clean code.

## Rules

Never delete code outside scope.
`;

const NO_H1_DOC = `## Section A

Content A.

## Section B

Content B.
`;

const SINGLE_SECTION_DOC = `# Analyst

Only one section with no H2 headings. Just a body.
`;

// ── chunkSkill ────────────────────────────────────────────────────────────────

describe("chunkSkill", () => {
  it("returns one chunk per H2 section", () => {
    const chunks = chunkSkill("programmer", SIMPLE_DOC);
    // H1 intro section + 2 H2 sections = 3 chunks
    expect(chunks.length).toBe(3);
  });

  it("each chunk carries the correct skillName", () => {
    const chunks = chunkSkill("programmer", SIMPLE_DOC);
    for (const chunk of chunks) {
      expect(chunk.skillName).toBe("programmer");
    }
  });

  it("chunkIndex is sequential starting from 0", () => {
    const chunks = chunkSkill("programmer", SIMPLE_DOC);
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
  });

  it("H2 chunks include the H1 title prefix", () => {
    const chunks = chunkSkill("programmer", SIMPLE_DOC);
    const h2Chunks = chunks.filter((c) => c.text.includes("## "));
    for (const chunk of h2Chunks) {
      expect(chunk.text).toMatch(/^# Programmer/);
    }
  });

  it("works when document has no H1 title", () => {
    const chunks = chunkSkill("analyst", NO_H1_DOC);
    expect(chunks.length).toBe(2);
  });

  it("H2 chunks have no double title prefix when no H1 is present", () => {
    const chunks = chunkSkill("analyst", NO_H1_DOC);
    expect(chunks[0]?.text).toMatch(/^## Section A/);
  });

  it("returns a single chunk for a doc with no H2 headings", () => {
    const chunks = chunkSkill("analyst", SINGLE_SECTION_DOC);
    expect(chunks.length).toBe(1);
  });

  it("returns empty array for empty content", () => {
    const chunks = chunkSkill("programmer", "");
    expect(chunks.length).toBe(0);
  });

  it("returns empty array for whitespace-only content", () => {
    const chunks = chunkSkill("programmer", "   \n\n  ");
    expect(chunks.length).toBe(0);
  });

  it("splits oversized sections on blank lines", () => {
    // Build a section larger than 3000 chars using many paragraphs
    const para = "x".repeat(400);
    const bigSection = `# Big\n\n## Section\n\n${Array(10).fill(para).join("\n\n")}`;
    const chunks = chunkSkill("big", bigSection, 3000);
    // Each chunk must be ≤ 3000 chars
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(3000);
    }
    // Must produce more than one chunk from the oversized section
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("emits a single oversized paragraph as its own chunk", () => {
    // One paragraph that is itself > maxChunkChars — must not be dropped
    const hugePara = "y".repeat(500);
    const doc = `# Skill\n\n## Section\n\n${hugePara}`;
    const chunks = chunkSkill("skill", doc, 100);
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes(hugePara))).toBe(true);
  });

  it("chunk text is trimmed (no leading/trailing whitespace)", () => {
    const chunks = chunkSkill("programmer", SIMPLE_DOC);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(chunk.text.trim());
    }
  });

  it("respects custom maxChunkChars", () => {
    const para = "z".repeat(200);
    const doc = `# S\n\n## A\n\n${Array(5).fill(para).join("\n\n")}`;
    const chunks = chunkSkill("s", doc, 500);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(500);
    }
  });
});
