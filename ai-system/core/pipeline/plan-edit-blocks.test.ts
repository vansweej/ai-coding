import { describe, expect, it } from "bun:test";

import { extractPlanEditPairs, simulatePlanEdits } from "./plan-edit-blocks";
import { parsePlanFile } from "./plan-parser";

const FENCE = "`".repeat(3);
const FENCE4 = "`".repeat(4);

function parseOk(text: string) {
  const result = parsePlanFile(text);
  if (!result.ok) throw new Error(`fixture failed to parse: ${result.error.message}`);
  return result.value;
}

describe("plan-edit-blocks", () => {
  it("extracts an OLD/NEW pair with a path in the OLD cue", () => {
    const text = [
      "# Feature: F",
      "## Phase 1: P",
      "Commit message: feat: x",
      "### Step 1: Edit",
      "OLD (`src/a.ts`):",
      `${FENCE}ts`,
      "const a = 1;",
      FENCE,
      "NEW:",
      `${FENCE}ts`,
      "const a = 2;",
      FENCE,
    ].join("\n");
    expect(extractPlanEditPairs(parseOk(text))).toEqual([
      {
        filePath: "src/a.ts",
        oldText: "const a = 1;",
        newText: "const a = 2;",
        phase: 1,
        step: 1,
      },
    ]);
  });

  it("extracts a pair wrapped in a 4-backtick outer fence containing inner triple fences", () => {
    const text = [
      "# Feature: F",
      "## Phase 1: P",
      "Commit message: feat: x",
      "### Step 1: Edit",
      "OLD (`src/a.ts`):",
      FENCE4,
      "before",
      FENCE,
      "inside",
      FENCE,
      "after",
      FENCE4,
      "NEW:",
      FENCE4,
      "replacement",
      FENCE4,
    ].join("\n");
    const pairs = extractPlanEditPairs(parseOk(text));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].oldText).toBe(["before", FENCE, "inside", FENCE, "after"].join("\n"));
    expect(pairs[0].newText).toBe("replacement");
  });

  it("infers the path from a single repo-relative token when no cue path is present", () => {
    const text = [
      "# Feature: F",
      "## Phase 1: P",
      "Commit message: feat: x",
      "### Step 1: Edit",
      "Update src/only.ts.",
      "OLD:",
      FENCE,
      "old",
      FENCE,
      "NEW:",
      FENCE,
      "new",
      FENCE,
    ].join("\n");
    const pairs = extractPlanEditPairs(parseOk(text));
    expect(pairs).toHaveLength(1);
    expect(pairs[0].filePath).toBe("src/only.ts");
  });

  it("applies sequential edits across phases over the virtual map", () => {
    const text = [
      "# Feature: F",
      "## Phase 1: First",
      "Commit message: feat: first",
      "### Step 1: Edit",
      "OLD (`src/a.ts`):",
      FENCE,
      "A",
      FENCE,
      "NEW:",
      FENCE,
      "B",
      FENCE,
      "## Phase 2: Second",
      "Commit message: feat: second",
      "### Step 1: Edit",
      "OLD (`src/a.ts`):",
      FENCE,
      "B",
      FENCE,
      "NEW:",
      FENCE,
      "C",
      FENCE,
    ].join("\n");
    const pairs = extractPlanEditPairs(parseOk(text));
    const reads: string[] = [];
    const result = simulatePlanEdits(pairs, (path) => {
      reads.push(path);
      return "A";
    });
    expect(pairs).toHaveLength(2);
    expect(result.violations).toEqual([]);
    expect(reads).toEqual(["src/a.ts"]);
  });

  it("flags anchor-not-found and anchor-not-unique", () => {
    const text = [
      "# Feature: F",
      "## Phase 1: P",
      "Commit message: feat: x",
      "### Step 1: Edit",
      "OLD (`src/a.ts`):",
      FENCE,
      "missing",
      FENCE,
      "NEW:",
      FENCE,
      "replacement",
      FENCE,
      "OLD (`src/a.ts`):",
      FENCE,
      "duplicate",
      FENCE,
      "NEW:",
      FENCE,
      "replacement",
      FENCE,
    ].join("\n");
    const pairs = extractPlanEditPairs(parseOk(text));
    const result = simulatePlanEdits(pairs, () => "duplicate duplicate");
    expect(pairs).toHaveLength(2);
    expect(result.violations.map((violation) => [violation.rule, violation.occurrences])).toEqual([
      ["anchor-not-found", 0],
      ["anchor-not-unique", 2],
    ]);
  });

  it("treats an empty-OLD pair on a missing file as a create", () => {
    const text = [
      "# Feature: F",
      "## Phase 1: P",
      "Commit message: feat: x",
      "### Step 1: Create",
      "OLD (`src/a.ts`):",
      FENCE,
      FENCE,
      "NEW:",
      FENCE,
      "created",
      FENCE,
      "### Step 2: Edit",
      "OLD (`src/a.ts`):",
      FENCE,
      "created",
      FENCE,
      "NEW:",
      FENCE,
      "updated",
      FENCE,
    ].join("\n");
    const pairs = extractPlanEditPairs(parseOk(text));
    let reads = 0;
    const result = simulatePlanEdits(pairs, () => {
      reads++;
      return undefined;
    });
    expect(pairs).toHaveLength(2);
    expect(result.violations).toEqual([]);
    expect(reads).toBe(1);
  });
});
