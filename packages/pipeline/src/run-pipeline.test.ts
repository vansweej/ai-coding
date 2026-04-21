import { describe, expect, it } from "bun:test";

import type { PipelineContext, PipelineStep, Result, StepResult } from "./pipeline-types";
import { runPipeline } from "./run-pipeline";

/** Minimal test event type -- no dependency on AIRequestEvent. */
interface TestEvent {
  readonly message: string;
}

/** Creates a mock step that returns a fixed output string. */
function mockStep(name: string, output: string): PipelineStep<TestEvent> {
  return {
    name,
    execute: async (_ctx: PipelineContext<TestEvent>): Promise<Result<StepResult>> => {
      const startedAt = Date.now();
      return {
        ok: true,
        value: { stepName: name, output, durationMs: Date.now() - startedAt },
      };
    },
  };
}

/** Creates a mock step that always fails with the given message. */
function failingStep(name: string, message: string): PipelineStep<TestEvent> {
  return {
    name,
    execute: async (_ctx: PipelineContext<TestEvent>): Promise<Result<StepResult>> => ({
      ok: false,
      error: new Error(message),
    }),
  };
}

/**
 * Creates a step that reads a previous step's output from context and appends
 * its own label -- used to verify context threading.
 */
function contextReadingStep(name: string, readFrom: string): PipelineStep<TestEvent> {
  return {
    name,
    execute: async (ctx: PipelineContext<TestEvent>): Promise<Result<StepResult>> => {
      const prior = ctx.results.get(readFrom)?.output ?? "(missing)";
      const output = `${prior} -> ${name}`;
      return { ok: true, value: { stepName: name, output, durationMs: 0 } };
    },
  };
}

const testEvent: TestEvent = { message: "test" };

describe("runPipeline", () => {
  it("runs all steps in sequence and returns outcome", async () => {
    const steps = [mockStep("a", "out-a"), mockStep("b", "out-b"), mockStep("c", "out-c")];
    const result = await runPipeline(steps, testEvent);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps).toHaveLength(3);
    expect(result.value.steps[0].stepName).toBe("a");
    expect(result.value.steps[1].stepName).toBe("b");
    expect(result.value.steps[2].stepName).toBe("c");
  });

  it("passes context between steps so each can read prior outputs", async () => {
    const steps = [mockStep("first", "hello"), contextReadingStep("second", "first")];
    const result = await runPipeline(steps, testEvent);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps[1].output).toBe("hello -> second");
  });

  it("stops on the first failing step and returns its error", async () => {
    let thirdExecuted = false;
    const third: PipelineStep<TestEvent> = {
      name: "third",
      execute: async () => {
        thirdExecuted = true;
        return { ok: true, value: { stepName: "third", output: "", durationMs: 0 } };
      },
    };

    const steps = [mockStep("first", "ok"), failingStep("second", "step two failed"), third];
    const result = await runPipeline(steps, testEvent);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("step two failed");
    expect(thirdExecuted).toBe(false);
  });

  it("returns error when given an empty steps array", async () => {
    const result = await runPipeline([], testEvent);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Pipeline has no steps");
  });

  it("returns error when two steps share the same name", async () => {
    const steps = [mockStep("plan", "out-a"), mockStep("plan", "out-b")];
    const result = await runPipeline(steps, testEvent);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Duplicate step name");
    expect(result.error.message).toContain("plan");
  });

  it("includes total duration in the outcome", async () => {
    const steps = [mockStep("a", "out-a"), mockStep("b", "out-b")];
    const result = await runPipeline(steps, testEvent);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("preserves the original event in context throughout all steps", async () => {
    const event: TestEvent = { message: "original" };
    let capturedEvent: TestEvent | undefined;

    const capturingStep: PipelineStep<TestEvent> = {
      name: "capture",
      execute: async (ctx: PipelineContext<TestEvent>): Promise<Result<StepResult>> => {
        capturedEvent = ctx.event;
        return { ok: true, value: { stepName: "capture", output: "", durationMs: 0 } };
      },
    };

    await runPipeline([mockStep("first", "ok"), capturingStep], event);

    expect(capturedEvent).toBe(event);
  });

  it("stores each step result in context by step name", async () => {
    const steps = [mockStep("alpha", "alpha-out"), mockStep("beta", "beta-out")];
    let capturedResults: Map<string, StepResult> | undefined;

    const readingStep: PipelineStep<TestEvent> = {
      name: "reader",
      execute: async (ctx: PipelineContext<TestEvent>): Promise<Result<StepResult>> => {
        capturedResults = ctx.results;
        return { ok: true, value: { stepName: "reader", output: "", durationMs: 0 } };
      },
    };

    await runPipeline([...steps, readingStep], testEvent);

    expect(capturedResults?.get("alpha")?.output).toBe("alpha-out");
    expect(capturedResults?.get("beta")?.output).toBe("beta-out");
  });
});
