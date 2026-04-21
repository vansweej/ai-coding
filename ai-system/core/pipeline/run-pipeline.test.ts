import { describe, expect, it } from "bun:test";

import type { AIRequestEvent, Result } from "@ai-coding/shared";

import type { PipelineContext, PipelineStep, StepResult } from "./pipeline-types";
import { runPipeline } from "./run-pipeline";

/** Creates a mock step that returns a fixed output string. */
function mockStep(name: string, output: string): PipelineStep {
  return {
    name,
    execute: async (ctx: PipelineContext): Promise<Result<StepResult>> => {
      const startedAt = Date.now();
      return {
        ok: true,
        value: { stepName: name, output, durationMs: Date.now() - startedAt },
      };
    },
  };
}

/** Creates a mock step that always fails with the given message. */
function failingStep(name: string, message: string): PipelineStep {
  return {
    name,
    execute: async (_ctx: PipelineContext): Promise<Result<StepResult>> => ({
      ok: false,
      error: new Error(message),
    }),
  };
}

/**
 * Creates a step that reads a previous step's output from context and appends
 * its own label to it -- used to verify context threading.
 */
function contextReadingStep(name: string, readFrom: string): PipelineStep {
  return {
    name,
    execute: async (ctx: PipelineContext): Promise<Result<StepResult>> => {
      const prior = ctx.results.get(readFrom)?.output ?? "(missing)";
      const output = `${prior} -> ${name}`;
      return { ok: true, value: { stepName: name, output, durationMs: 0 } };
    },
  };
}

/** Builds a minimal AIRequestEvent for testing. */
function makeEvent(
  overrides: Partial<AIRequestEvent> & Pick<AIRequestEvent, "action" | "source">,
): AIRequestEvent {
  return {
    id: "test-1",
    timestamp: Date.now(),
    payload: {},
    ...overrides,
  };
}

describe("runPipeline", () => {
  it("runs all steps in sequence and returns outcome", async () => {
    const steps = [mockStep("a", "out-a"), mockStep("b", "out-b"), mockStep("c", "out-c")];
    const result = await runPipeline(steps, makeEvent({ source: "cli", action: "plan" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps).toHaveLength(3);
    expect(result.value.steps[0].stepName).toBe("a");
    expect(result.value.steps[1].stepName).toBe("b");
    expect(result.value.steps[2].stepName).toBe("c");
  });

  it("passes context between steps so each can read prior outputs", async () => {
    const steps = [mockStep("first", "hello"), contextReadingStep("second", "first")];
    const result = await runPipeline(steps, makeEvent({ source: "cli", action: "edit" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps[1].output).toBe("hello -> second");
  });

  it("stops on the first failing step and returns its error", async () => {
    let thirdExecuted = false;
    const third: PipelineStep = {
      name: "third",
      execute: async () => {
        thirdExecuted = true;
        return { ok: true, value: { stepName: "third", output: "", durationMs: 0 } };
      },
    };

    const steps = [mockStep("first", "ok"), failingStep("second", "step two failed"), third];
    const result = await runPipeline(steps, makeEvent({ source: "cli", action: "plan" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("step two failed");
    expect(thirdExecuted).toBe(false);
  });

  it("returns error when given an empty steps array", async () => {
    const result = await runPipeline([], makeEvent({ source: "cli", action: "plan" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("Pipeline has no steps");
  });

  it("returns error when two steps share the same name", async () => {
    const steps = [mockStep("plan", "out-a"), mockStep("plan", "out-b")];
    const result = await runPipeline(steps, makeEvent({ source: "cli", action: "plan" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Duplicate step name");
    expect(result.error.message).toContain("plan");
  });

  it("includes total duration in the outcome", async () => {
    const steps = [mockStep("a", "out-a"), mockStep("b", "out-b")];
    const result = await runPipeline(steps, makeEvent({ source: "cli", action: "edit" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("preserves the original event in context throughout all steps", async () => {
    const event = makeEvent({ source: "agent", action: "task", payload: { input: "do work" } });
    let capturedEvent: AIRequestEvent | undefined;

    const capturingStep: PipelineStep = {
      name: "capture",
      execute: async (ctx: PipelineContext): Promise<Result<StepResult>> => {
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

    const readingStep: PipelineStep = {
      name: "reader",
      execute: async (ctx: PipelineContext): Promise<Result<StepResult>> => {
        capturedResults = ctx.results;
        return { ok: true, value: { stepName: "reader", output: "", durationMs: 0 } };
      },
    };

    await runPipeline([...steps, readingStep], makeEvent({ source: "cli", action: "edit" }));

    expect(capturedResults?.get("alpha")?.output).toBe("alpha-out");
    expect(capturedResults?.get("beta")?.output).toBe("beta-out");
  });
});
