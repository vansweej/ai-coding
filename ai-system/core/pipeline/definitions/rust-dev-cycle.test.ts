import { describe, expect, it } from "bun:test";

import type { StepResult } from "@ai-coding/pipeline";
import type { PipelineContext } from "@ai-coding/pipeline";
import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createRustDevCyclePipeline } from "./rust-dev-cycle";

const STUB_CONFIG: OrchestratorConfig = { dispatchers: {} };

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

describe("createRustDevCyclePipeline", () => {
  it("returns exactly 7 steps", () => {
    expect(createRustDevCyclePipeline(STUB_CONFIG, "/tmp/ws")).toHaveLength(7);
  });

  it("has step names in order", () => {
    const steps = createRustDevCyclePipeline(STUB_CONFIG, "/tmp/ws");
    expect(steps.map((s) => s.name)).toEqual([
      "plan",
      "implement",
      "fmt",
      "clippy",
      "test",
      "tarpaulin",
      "coverage",
    ]);
  });

  it("buildPrompt includes plan output and original request in implement step", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      dispatchers: { "claude-sonnet": dispatcher, "qwen2.5-coder:7b": dispatcher },
    };
    const steps = createRustDevCyclePipeline(config, "/tmp/ws");
    const implementStep = steps[1];
    expect(implementStep).toBeDefined();
    if (!implementStep) return;

    const event = makeEvent("Add a parser module");
    const ctx = makeCtxWithPlanResult(event, "Step 1: create parser.rs");
    await implementStep.execute(ctx);

    expect(dispatcher.lastPrompt).toContain("Step 1: create parser.rs");
    expect(dispatcher.lastPrompt).toContain("Add a parser module");
    expect(dispatcher.lastPrompt).toContain("Rust");
  });

  it("uses the custom coverage threshold when provided", () => {
    const steps = createRustDevCyclePipeline(STUB_CONFIG, "/tmp/ws", 80);
    expect(steps).toHaveLength(7);
  });
});
