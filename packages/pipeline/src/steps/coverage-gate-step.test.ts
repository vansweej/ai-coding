import { describe, expect, it } from "bun:test";

import type { PipelineContext, StepResult } from "../pipeline-types";
import { createCoverageGateStep } from "./coverage-gate-step";

/** Minimal test event. */
interface TestEvent {
  readonly id: string;
}

/** Builds a context with a prior step output already in results. */
function makeCtx(stepName: string, output: string): PipelineContext<TestEvent> {
  const results = new Map<string, StepResult>();
  results.set(stepName, { stepName, output, durationMs: 0 });
  return { event: { id: "test" }, results };
}

describe("createCoverageGateStep", () => {
  it("passes when coverage meets the threshold", async () => {
    const ctx = makeCtx("tarpaulin", "92.50% coverage, 37/40 lines covered");
    const step = createCoverageGateStep<TestEvent>("coverage", "tarpaulin", 90);
    const result = await step.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toContain("92.50%");
    expect(result.value.output).toContain("threshold: 90%");
  });

  it("passes when coverage exactly equals the threshold", async () => {
    const ctx = makeCtx("tarpaulin", "90.00% coverage, 36/40 lines covered");
    const step = createCoverageGateStep<TestEvent>("coverage", "tarpaulin", 90);
    const result = await step.execute(ctx);

    expect(result.ok).toBe(true);
  });

  it("fails when coverage is below the threshold", async () => {
    const ctx = makeCtx("tarpaulin", "87.50% coverage, 35/40 lines covered");
    const step = createCoverageGateStep<TestEvent>("coverage", "tarpaulin", 90);
    const result = await step.execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("87.50%");
    expect(result.error.message).toContain("below threshold 90%");
  });

  it("fails when prior step output contains no parseable percentage", async () => {
    const ctx = makeCtx("tarpaulin", "error: compilation failed");
    const step = createCoverageGateStep<TestEvent>("coverage", "tarpaulin", 90);
    const result = await step.execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("could not parse coverage percentage");
    expect(result.error.message).toContain("tarpaulin");
  });

  it("fails when the referenced step has no output in context", async () => {
    const ctx: PipelineContext<TestEvent> = { event: { id: "test" }, results: new Map() };
    const step = createCoverageGateStep<TestEvent>("coverage", "tarpaulin", 90);
    const result = await step.execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("could not parse coverage percentage");
  });

  it("accepts a custom regex pattern", async () => {
    const ctx = makeCtx("gcovr", "lines: 95.3%");
    const step = createCoverageGateStep<TestEvent>(
      "coverage",
      "gcovr",
      90,
      /lines:\s*(\d+\.?\d*)%/i,
    );
    const result = await step.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toContain("95.30%");
  });

  it("records the step name and non-negative durationMs in the result", async () => {
    const ctx = makeCtx("tarpaulin", "95.00% coverage, 38/40 lines covered");
    const step = createCoverageGateStep<TestEvent>("my-gate", "tarpaulin", 90);
    const result = await step.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stepName).toBe("my-gate");
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });
});
