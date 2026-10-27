import { describe, expect, it } from "bun:test";

import { parsePlanFile } from "./plan-parser";
import { runPreflight } from "./preflight";

const FENCE = "`".repeat(3);

function parseOk(text: string) {
  const result = parsePlanFile(text);
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.error.message}`);
  return result.value;
}

const existsAll = () => true;
const existsNone = () => false;

describe("runPreflight", () => {
  it("flags assert-path-missing when a path is absent and unmentioned", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "Assert: exists src/ghost.ts",
      "",
      "### Step 1: Do",
      "",
      "body mentions nothing relevant",
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsNone });
    expect(report.violations.some((v) => v.rule === "assert-path-missing")).toBe(true);
  });

  it("does not flag assert-path-missing when a step mentions the path", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "Assert: exists src/real.ts",
      "",
      "### Step 1: Do",
      "",
      "Create src/real.ts with content",
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsNone });
    expect(report.violations.some((v) => v.rule === "assert-path-missing")).toBe(false);
  });

  it("does not flag assert-path-missing when a ./-prefixed path is mentioned without the prefix", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "Assert: exists ./src/real.ts",
      "",
      "### Step 1: Do",
      "",
      "Create src/real.ts with content",
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsNone });
    expect(report.violations.some((v) => v.rule === "assert-path-missing")).toBe(false);
  });

  it("does not flag assert-path-missing for not-exists assertions", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "Assert: not-exists src/gone.ts",
      "",
      "### Step 1: Do",
      "",
      "body mentions src/other.ts",
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsNone });
    expect(report.violations.some((v) => v.rule === "assert-path-missing")).toBe(false);
  });

  it("does not flag assert-path-missing when the file exists on disk", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "Assert: exists src/present.ts",
      "",
      "### Step 1: Do",
      "",
      "unrelated body text only",
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsAll });
    expect(report.violations.some((v) => v.rule === "assert-path-missing")).toBe(false);
  });

  it("warns commit-message-normalized when the parser stripped delimiters", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: `feat: wrapped`",
      "",
      "### Step 1: Do",
      "",
      "body mentions src/x.ts",
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsAll });
    expect(report.violations.some((v) => v.rule === "commit-message-normalized")).toBe(true);
  });

  it("does not warn commit-message-normalized for a clean message", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: clean",
      "",
      "### Step 1: Do",
      "",
      "body mentions src/x.ts",
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsAll });
    expect(report.violations.some((v) => v.rule === "commit-message-normalized")).toBe(false);
  });

  it("warns step-without-edit-target for a step naming no file", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "### Step 1: Vague",
      "",
      "make it better somehow",
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsAll });
    expect(report.violations.some((v) => v.rule === "step-without-edit-target")).toBe(true);
  });

  it("does not warn step-without-edit-target when the step names a file", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "### Step 1: Edit",
      "",
      "edit src/thing.ts to add a field",
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsAll });
    expect(report.violations.some((v) => v.rule === "step-without-edit-target")).toBe(false);
  });

  it("does not warn step-without-edit-target for a verify-only phase", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "Mode: verify-only",
      "",
      "Assert: exists src/real.ts",
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsAll });
    expect(report.violations.some((v) => v.rule === "step-without-edit-target")).toBe(false);
  });

  it("flags anchor-ellipsis for an elided anchor block", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "### Step 1: Edit",
      "",
      "edit src/x.ts",
      "",
      "Locate (unique):",
      "",
      FENCE,
      "const a = 1;",
      "// ...",
      "const b = 2;",
      FENCE,
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsAll });
    expect(report.violations.some((v) => v.rule === "anchor-ellipsis")).toBe(true);
  });

  it("flags anchor-ellipsis for a unicode ellipsis in an anchor block", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "### Step 1: Edit",
      "",
      "edit src/x.ts",
      "",
      "Locate (unique):",
      "",
      FENCE,
      `// ${String.fromCodePoint(0x2026)}`,
      FENCE,
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsAll });
    expect(report.violations.some((v) => v.rule === "anchor-ellipsis")).toBe(true);
  });

  it("does not flag a JS spread as anchor-ellipsis", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "### Step 1: Edit",
      "",
      "edit src/x.ts",
      "",
      "Replace with:",
      "",
      FENCE,
      "return fn(...args);",
      FENCE,
      "",
    ].join("\n");
    const report = runPreflight({ plan: parseOk(text), planText: text, fileExists: existsAll });
    expect(report.violations.some((v) => v.rule === "anchor-ellipsis")).toBe(false);
  });

  it("never throws on a minimal single-step plan", () => {
    const text = [
      "# Feature: F",
      "",
      "## Phase 1: P",
      "",
      "Commit message: feat: x",
      "",
      "### Step 1: Edit",
      "",
      "edit src/x.ts",
      "",
    ].join("\n");
    expect(() =>
      runPreflight({ plan: parseOk(text), planText: text, fileExists: existsAll }),
    ).not.toThrow();
  });
});
