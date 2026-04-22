import { describe, expect, it } from "bun:test";

import type { StepResult } from "@ai-coding/pipeline";
import type { PipelineContext } from "@ai-coding/pipeline";
import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";
import type { AIRequestEvent } from "@ai-coding/shared";

import { COPILOT_DEFAULT_PROFILE } from "../../../config/model-profiles";
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
      return { ok: true, value: "```typescript src/index.ts\nconsole.log('hello');\n```" };
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
  it("returns exactly 4 steps", () => {
    expect(createDevCyclePipeline(STUB_CONFIG)).toHaveLength(4);
  });

  it("has step names in order: plan, implement, write-files, test", () => {
    const steps = createDevCyclePipeline(STUB_CONFIG);
    expect(steps.map((s) => s.name)).toEqual(["plan", "implement", "write-files", "test"]);
  });

  it("buildPrompt includes plan output and original request in implement step", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: COPILOT_DEFAULT_PROFILE,
      dispatchers: { "claude-sonnet-4.6": dispatcher },
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

  it("implement step system prompt requires fenced code blocks with file paths", async () => {
    const captured: { system?: string } = {};
    const dispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        captured.system = req.system;
        return { ok: true, value: "```typescript src/index.ts\nconsole.log('hello');\n```" };
      },
    };
    const config: OrchestratorConfig = {
      profile: COPILOT_DEFAULT_PROFILE,
      dispatchers: { "claude-sonnet-4.6": dispatcher },
    };
    const steps = createDevCyclePipeline(config, "/tmp/ws");
    const implementStep = steps[1];
    if (!implementStep) return;

    const event = makeEvent("Add error handling");
    const ctx = makeCtxWithPlanResult(event, "plan output");
    await implementStep.execute(ctx);

    expect(captured.system).toContain("fenced code blocks");
    expect(captured.system).toContain("relative-file-path");
  });
});
