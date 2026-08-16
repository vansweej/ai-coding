import { describe, expect, it } from "bun:test";

import type { PipelineContext, StepResult } from "@ai-coding/pipeline";
import { createCoverageGateStep } from "@ai-coding/pipeline";

interface TestEvent {
  readonly id: string;
}

function makeCtx(stepName: string, output: string): PipelineContext<TestEvent> {
  const results = new Map<string, StepResult>();
  results.set(stepName, { stepName, output, durationMs: 0 });
  return { event: { id: "test" }, results };
}

describe("coverage gate hard-fail", () => {
  it("fails when coverage is below threshold", async () => {
    const ctx = makeCtx("tarpaulin", "72.00% coverage, 36/50 lines covered");
    const step = createCoverageGateStep<TestEvent>("coverage", "tarpaulin", 90);
    const result = await step.execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("72.00%");
    expect(result.error.message).toContain("below threshold 90%");
  });

  it("passes when coverage meets the threshold", async () => {
    const ctx = makeCtx("tarpaulin", "91.00% coverage, 91/100 lines covered");
    const step = createCoverageGateStep<TestEvent>("coverage", "tarpaulin", 90);
    const result = await step.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toContain("91.00%");
  });

  it("passes when coverage exactly equals the threshold", async () => {
    const ctx = makeCtx("tarpaulin", "90.00% coverage, 90/100 lines covered");
    const step = createCoverageGateStep<TestEvent>("coverage", "tarpaulin", 90);
    const result = await step.execute(ctx);

    expect(result.ok).toBe(true);
  });

  it("there is no warnOnly escape hatch — below-threshold always returns ok:false", async () => {
    // Previously createCoverageGateStep accepted a 5th warnOnly arg that returned ok:true
    // on shortfall. That escape hatch is removed; the function now only takes 4 args.
    // TypeScript enforces this — passing a 5th arg is a compile error.
    const ctx = makeCtx("tarpaulin", "50.00% coverage, 25/50 lines covered");
    const step = createCoverageGateStep<TestEvent>("coverage", "tarpaulin", 90);
    const result = await step.execute(ctx);

    // Must be a hard failure regardless of any wishful thinking
    expect(result.ok).toBe(false);
  });
});
