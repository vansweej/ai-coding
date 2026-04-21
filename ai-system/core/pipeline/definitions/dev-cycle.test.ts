import { describe, expect, it } from "bun:test";

import type { StepResult } from "@ai-coding/pipeline";
import type { PipelineContext } from "@ai-coding/pipeline";
import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createDevCyclePipeline } from "./dev-cycle";

const STUB_CONFIG: OrchestratorConfig = { dispatchers: {} };

/** Mock dispatcher that captures the last prompt it received. */
function capturingDispatcher(): ModelDispatcher & { lastPrompt: string } {
  const state = { lastPrompt: "" };
  const dispatcher: ModelDispatcher & { lastPrompt: string } = {
    get lastPrompt() {
      return state.lastPrompt;
    },
    dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
      state.lastPrompt = req.prompt;
      return { ok: true, value: "mock response" };
    },
  };
  return dispatcher;
}

function makeEvent(input: string): AIRequestEvent {
  return {
    id: "test",
    timestamp: Date.now(),
    source: "cli",
    action: "task",
    payload: { input },
  };
}

function makeCtxWithPlanResult(
  event: AIRequestEvent,
  planOutput: string,
): PipelineContext<AIRequestEvent> {
  const planResult: StepResult = { stepName: "plan", output: planOutput, durationMs: 0 };
  return { event, results: new Map([["plan", planResult]]) };
}

describe("createDevCyclePipeline", () => {
  it("returns exactly 3 steps", () => {
    expect(createDevCyclePipeline(STUB_CONFIG)).toHaveLength(3);
  });

  it("has step names in order: plan, implement, test", () => {
    const steps = createDevCyclePipeline(STUB_CONFIG);
    expect(steps.map((s) => s.name)).toEqual(["plan", "implement", "test"]);
  });

  it("buildPrompt includes plan output and original request in implement step", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      dispatchers: { "claude-sonnet": dispatcher, "qwen2.5-coder:7b": dispatcher },
    };
    const steps = createDevCyclePipeline(config, "/tmp/ws");
    const implementStep = steps[1];
    expect(implementStep).toBeDefined();
    if (!implementStep) return;

    const event = makeEvent("Add error handling");
    const ctx = makeCtxWithPlanResult(event, "Step 1: handle errors gracefully");
    await implementStep.execute(ctx);

    expect(dispatcher.lastPrompt).toContain("Step 1: handle errors gracefully");
    expect(dispatcher.lastPrompt).toContain("Add error handling");
  });
});
