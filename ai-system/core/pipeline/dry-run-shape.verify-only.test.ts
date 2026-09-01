import { describe, expect, it } from "bun:test";

import { formatPredictedRunShape, predictRunShape, runShapeToLedgerPayload } from "./dry-run-shape";
import type { PlanFile } from "./plan-parser";

function plan(verifyOnly?: boolean): PlanFile {
  return {
    feature: "Verify-only shape",
    phases: [
      {
        number: 1,
        title: "Verify",
        commitMessage: "test: shape",
        steps: [],
        coverage: { mode: "default" },
        verifyOnly,
        assertions: [{ kind: "exists", path: "README.md" }],
      },
    ],
  };
}

describe("verify-only dry-run shape", () => {
  it("surfaces a declared verify-only phase", () => {
    const shape = predictRunShape(plan(true), new Set<string>());

    expect(shape.phases[0]?.verifyOnly).toBe(true);
  });

  it("defaults an omitted verify-only field to false", () => {
    const shape = predictRunShape(plan(), new Set<string>());

    expect(shape.phases[0]?.verifyOnly).toBe(false);
  });

  it("formats the verify-only marker only when declared", () => {
    const verifyOnlyOutput = formatPredictedRunShape(
      predictRunShape(plan(true), new Set<string>()),
    );
    const regularOutput = formatPredictedRunShape(predictRunShape(plan(), new Set<string>()));

    expect(verifyOnlyOutput).toContain(" [verify-only]");
    expect(regularOutput).not.toContain(" [verify-only]");
  });

  it("includes verifyOnly in the ledger payload", () => {
    const payload = runShapeToLedgerPayload(predictRunShape(plan(true), new Set<string>()));
    const phases = payload.phases;

    expect(Array.isArray(phases)).toBe(true);
    if (Array.isArray(phases)) expect(phases[0]).toMatchObject({ verifyOnly: true });
  });
});
