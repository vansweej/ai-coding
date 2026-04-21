import { describe, expect, it } from "bun:test";

import type { PipelineContext } from "@ai-coding/pipeline";
import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import type { LLMOptions, OrchestratorConfig } from "../../../core/orchestrator/orchestrate";
import { createOrchestratorStep } from "./orchestrator-step";

/** Creates a mock dispatcher that returns a fixed response string. */
function mockDispatcher(response: string): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: response,
    }),
  };
}

/** Creates a mock dispatcher that always fails. */
function failingDispatcher(message: string): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: false,
      error: new Error(message),
    }),
  };
}

/** Standard config covering all three model backends. */
function makeConfig(overrides?: Partial<OrchestratorConfig["dispatchers"]>): OrchestratorConfig {
  return {
    dispatchers: {
      "claude-sonnet": mockDispatcher("plan-response"),
      "deepseek-coder-v2": mockDispatcher("debug-response"),
      "qwen3:8b": mockDispatcher("default-response"),
      ...overrides,
    },
  };
}

/** Builds a minimal AIRequestEvent. */
function makeEvent(
  overrides: Partial<AIRequestEvent> & Pick<AIRequestEvent, "action" | "source">,
): AIRequestEvent {
  return {
    id: "test-1",
    timestamp: Date.now(),
    payload: { input: "original input" },
    ...overrides,
  };
}

/** Builds a minimal PipelineContext with empty results. */
function makeCtx(event: AIRequestEvent): PipelineContext<AIRequestEvent> {
  return { event, results: new Map() };
}

describe("createOrchestratorStep", () => {
  it("dispatches to orchestrator with the overridden action", async () => {
    const step = createOrchestratorStep("my-plan", "plan", makeConfig());
    const ctx = makeCtx(makeEvent({ source: "cli", action: "edit" }));

    const result = await step.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // plan action → claude-sonnet → "plan-response"
    expect(result.value.output).toBe("plan-response");
  });

  it("uses buildPrompt to construct the input from context", async () => {
    let capturedPrompt = "";
    const capturingDispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        capturedPrompt = req.prompt;
        return { ok: true, value: "captured" };
      },
    };

    const config = makeConfig({ "qwen3:8b": capturingDispatcher });
    const step = createOrchestratorStep(
      "implement",
      "edit",
      config,
      (_ctx) => "custom built prompt",
    );
    const ctx = makeCtx(makeEvent({ source: "cli", action: "plan" }));

    await step.execute(ctx);

    expect(capturedPrompt).toBe("custom built prompt");
  });

  it("uses original payload.input when no buildPrompt is provided", async () => {
    let capturedPrompt = "";
    const capturingDispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        capturedPrompt = req.prompt;
        return { ok: true, value: "ok" };
      },
    };

    const config = makeConfig({ "qwen3:8b": capturingDispatcher });
    const step = createOrchestratorStep("edit-step", "edit", config);
    const ctx = makeCtx(makeEvent({ source: "cli", action: "plan" }));

    await step.execute(ctx);

    expect(capturedPrompt).toBe("original input");
  });

  it("uses empty string when payload.input is undefined and no buildPrompt given", async () => {
    let capturedPrompt = "sentinel";
    const capturingDispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        capturedPrompt = req.prompt;
        return { ok: true, value: "ok" };
      },
    };

    const config = makeConfig({ "qwen3:8b": capturingDispatcher });
    const step = createOrchestratorStep("edit-step", "edit", config);
    const event: AIRequestEvent = {
      id: "t",
      timestamp: Date.now(),
      source: "cli",
      action: "edit",
      payload: {},
    };
    const ctx = makeCtx(event);

    await step.execute(ctx);

    expect(capturedPrompt).toBe("");
  });

  it("buildPrompt receives context so it can read prior step outputs", async () => {
    const ctx = makeCtx(makeEvent({ source: "cli", action: "plan" }));
    ctx.results.set("plan", { stepName: "plan", output: "the plan", durationMs: 0 });

    let capturedPrompt = "";
    const capturingDispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        capturedPrompt = req.prompt;
        return { ok: true, value: "ok" };
      },
    };

    const config = makeConfig({ "qwen3:8b": capturingDispatcher });
    const step = createOrchestratorStep(
      "implement",
      "edit",
      config,
      (c) => `implement: ${c.results.get("plan")?.output ?? ""}`,
    );

    await step.execute(ctx);

    expect(capturedPrompt).toBe("implement: the plan");
  });

  it("propagates orchestrator errors when dispatcher is missing", async () => {
    const step = createOrchestratorStep("plan-step", "plan", { dispatchers: {} });
    const ctx = makeCtx(makeEvent({ source: "cli", action: "edit" }));

    const result = await step.execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("No dispatcher configured");
  });

  it("propagates dispatcher failure", async () => {
    const config = makeConfig({ "qwen3:8b": failingDispatcher("timeout") });
    const step = createOrchestratorStep("edit-step", "edit", config);
    const ctx = makeCtx(makeEvent({ source: "cli", action: "plan" }));

    const result = await step.execute(ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("timeout");
  });

  it("records step name and non-negative durationMs in the result", async () => {
    const step = createOrchestratorStep("named-step", "edit", makeConfig());
    const ctx = makeCtx(makeEvent({ source: "cli", action: "plan" }));

    const result = await step.execute(ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stepName).toBe("named-step");
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("forwards llmOptions to the dispatcher via orchestrate", async () => {
    let capturedRequest: DispatchRequest | undefined;
    const capturingDispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        capturedRequest = req;
        return { ok: true, value: "ok" };
      },
    };

    const config = makeConfig({ "qwen3:8b": capturingDispatcher });
    const llmOptions: LLMOptions = {
      system: "You are a code generator.",
      temperature: 0.3,
      maxTokens: 256,
    };
    const step = createOrchestratorStep("edit-step", "edit", config, undefined, llmOptions);
    const ctx = makeCtx(makeEvent({ source: "cli", action: "plan" }));

    await step.execute(ctx);

    expect(capturedRequest?.system).toBe("You are a code generator.");
    expect(capturedRequest?.temperature).toBe(0.3);
    expect(capturedRequest?.maxTokens).toBe(256);
  });
});
