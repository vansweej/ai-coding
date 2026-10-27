import { describe, expect, it } from "bun:test";

import { normalizeCommitMessage, parsePlanFile } from "./plan-parser";

describe("normalizeCommitMessage and parser integration", () => {
  it("strips a surrounding backtick pair and reports normalized", () => {
    const result = normalizeCommitMessage("`feat: do a thing`");
    expect(result.message).toBe("feat: do a thing");
    expect(result.normalized).toBe(true);
  });

  it("strips a surrounding double-quote pair", () => {
    const result = normalizeCommitMessage('"feat: quoted"');
    expect(result.message).toBe("feat: quoted");
    expect(result.normalized).toBe(true);
  });

  it("strips a surrounding single-quote pair", () => {
    const result = normalizeCommitMessage("'feat: quoted'");
    expect(result.message).toBe("feat: quoted");
    expect(result.normalized).toBe(true);
  });

  it("leaves mismatched delimiters unchanged", () => {
    const result = normalizeCommitMessage('`feat: mismatch"');
    expect(result.message).toBe('`feat: mismatch"');
    expect(result.normalized).toBe(false);
  });

  it("leaves an unwrapped message unchanged", () => {
    const result = normalizeCommitMessage("feat: plain");
    expect(result.message).toBe("feat: plain");
    expect(result.normalized).toBe(false);
  });

  it("treats a bare matching delimiter pair as empty and normalized", () => {
    const result = normalizeCommitMessage("``");
    expect(result.message).toBe("");
    expect(result.normalized).toBe(true);
  });

  it("parses a plan whose commit message is backtick-wrapped", () => {
    const plan = [
      "# Feature: Normalize",
      "",
      "## Phase 1: Only phase",
      "",
      "Commit message: `feat: wrapped subject`",
      "",
      "### Step 1: Do",
      "",
      "body mentions src/foo.ts",
      "",
    ].join("\n");
    const result = parsePlanFile(plan);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const phase = result.value.phases[0];
      expect(phase.commitMessage).toBe("feat: wrapped subject");
      expect(phase.commitMessageNormalized).toBe(true);
    }
  });

  it("rejects a plan whose commit message is an empty quote pair", () => {
    const plan = [
      "# Feature: Empty",
      "",
      "## Phase 1: Only phase",
      "",
      'Commit message: ""',
      "",
      "### Step 1: Do",
      "",
      "body",
      "",
    ].join("\n");
    const result = parsePlanFile(plan);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty");
      expect(result.error.message).toContain("after normalization");
    }
  });
});
