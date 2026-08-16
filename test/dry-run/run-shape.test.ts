import { describe, expect, it } from "bun:test";

import {
  formatPredictedRunShape,
  predictRunShape,
  runShapeToLedgerPayload,
} from "../../ai-system/core/pipeline/dry-run-shape";
import { parsePlanFile } from "../../ai-system/core/pipeline/plan-parser";

const MULTI_PHASE_PLAN = `# Feature: Dry-run shape prediction

## Phase 1: Core module

Commit message: feat: add core module
Assert: exists src/core.rs
Assert: contains src/core.rs :: pub fn

### Step 1: Create core module

Create src/core.rs.

### Step 2: Add function

Add a function to src/core.rs.

## Phase 2: Documentation

Commit message: docs: document core module
Coverage: skip
Assert: contains README.md :: Core module

### Step 1: Update README

Update README.md.
`;

describe("predictRunShape", () => {
  it("matches expected phase/step/assert counts", () => {
    const parsed = parsePlanFile(MULTI_PHASE_PLAN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const shape = predictRunShape(parsed.value, new Set(["cargo"]));

    expect(shape.feature).toBe("Dry-run shape prediction");
    expect(shape.phaseCount).toBe(2);

    expect(shape.phases[0]).toMatchObject({
      phase: 1,
      title: "Core module",
      stepCount: 2,
      assertCount: 2,
      coverage: "default",
    });

    expect(shape.phases[1]).toMatchObject({
      phase: 2,
      title: "Documentation",
      stepCount: 1,
      assertCount: 1,
      coverage: "skip",
    });
  });

  it("flags a phase whose declared Assert paths all route to no toolchain (README.md, no cargo needed)", () => {
    const parsed = parsePlanFile(MULTI_PHASE_PLAN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // Phase 1 asserts on src/core.rs (routes to rust with cargo present) --
    // not vacuous. Phase 2 asserts only on README.md -- always floor-only.
    const shape = predictRunShape(parsed.value, new Set(["cargo"]));

    expect(shape.phases[0]?.vacuousFloorOnlyWarning).toBe(false);
    expect(shape.phases[1]?.vacuousFloorOnlyWarning).toBe(true);
  });

  it("does not flag a phase with no assertions at all", () => {
    const plan = `# Feature: No asserts

## Phase 1: Simple

Commit message: feat: simple

### Step 1: Do it

Do something.
`;
    const parsed = parsePlanFile(plan);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const shape = predictRunShape(parsed.value, new Set());
    expect(shape.phases[0]?.vacuousFloorOnlyWarning).toBe(false);
  });

  it("flags vacuous when the asserted path's toolchain driver is absent from the palette", () => {
    const plan = `# Feature: Missing driver

## Phase 1: Rust work

Commit message: feat: rust work
Assert: exists src/lib.rs

### Step 1: Do it

Do something.
`;
    const parsed = parsePlanFile(plan);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // No "cargo" in the palette -- src/lib.rs routes to the floor.
    const shape = predictRunShape(parsed.value, new Set());
    expect(shape.phases[0]?.vacuousFloorOnlyWarning).toBe(true);
  });

  it("formatPredictedRunShape produces a non-empty summary containing phase titles", () => {
    const parsed = parsePlanFile(MULTI_PHASE_PLAN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const shape = predictRunShape(parsed.value, new Set(["cargo"]));
    const summary = formatPredictedRunShape(shape);

    expect(summary).toContain("Dry-run shape prediction");
    expect(summary).toContain("Core module");
    expect(summary).toContain("Documentation");
    expect(summary).toContain("WARN");
  });

  it("runShapeToLedgerPayload emits a run-shape line with matching phase/step/assert numbers, zero dispatch calls", () => {
    const parsed = parsePlanFile(MULTI_PHASE_PLAN);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const shape = predictRunShape(parsed.value, new Set(["cargo"]));
    const payload = runShapeToLedgerPayload(shape);

    // Simulate what run-pipeline-cli.ts would do: wrap payload in a
    // run-shape kind ledger line.
    const ledgerLine = {
      schema_version: 1,
      runId: "test-run-id",
      ts: new Date().toISOString(),
      kind: "run-shape",
      payload,
    };

    expect(ledgerLine.kind).toBe("run-shape");
    expect(payload.feature).toBe("Dry-run shape prediction");
    expect(payload.phaseCount).toBe(2);

    const phases = payload.phases as Array<Record<string, unknown>>;
    expect(phases).toHaveLength(2);
    expect(phases[0]).toMatchObject({ phase: 1, stepCount: 2, assertCount: 2 });
    expect(phases[1]).toMatchObject({ phase: 2, stepCount: 1, assertCount: 1 });
  });
});
