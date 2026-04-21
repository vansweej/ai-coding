import { describe, expect, it } from "bun:test";

import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import type { LLMOptions, OrchestratorConfig } from "./orchestrate";
import { orchestrate } from "./orchestrate";

/** Creates a mock dispatcher that returns a fixed response. */
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

/** Builds a minimal AIRequestEvent. */
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

/** Standard config covering all three model backends. */
function makeConfig(overrides?: Partial<OrchestratorConfig["dispatchers"]>): OrchestratorConfig {
  return {
    dispatchers: {
      "claude-sonnet-4.6": mockDispatcher("plan-response"),
      "deepseek-coder-v2": mockDispatcher("debug-response"),
      "qwen3:8b": mockDispatcher("default-response"),
      ...overrides,
    },
  };
}

describe("orchestrate", () => {
  it("routes plan action from CLI to claude-sonnet", async () => {
    const result = await orchestrate(
      makeEvent({ source: "cli", action: "plan", payload: { input: "design a feature" } }),
      makeConfig(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("claude-sonnet-4.6");
    expect(result.value.mode).toBe("agentic");
    expect(result.value.action).toBe("plan");
    expect(result.value.response).toBe("plan-response");
  });

  it("routes debug action from CLI to deepseek-coder-v2", async () => {
    const result = await orchestrate(
      makeEvent({ source: "cli", action: "debug", payload: { input: "find the bug" } }),
      makeConfig(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("deepseek-coder-v2");
    expect(result.value.response).toBe("debug-response");
  });

  it("routes edit action from CLI to qwen (agentic default)", async () => {
    const result = await orchestrate(makeEvent({ source: "cli", action: "edit" }), makeConfig());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("qwen3:8b");
    expect(result.value.mode).toBe("agentic");
  });

  it("routes any action from nvim to qwen (editor mode)", async () => {
    const result = await orchestrate(makeEvent({ source: "nvim", action: "plan" }), makeConfig());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.model).toBe("qwen3:8b");
    expect(result.value.mode).toBe("editor");
  });

  it("returns error when dispatcher is not configured for model", async () => {
    const result = await orchestrate(makeEvent({ source: "cli", action: "plan" }), {
      dispatchers: {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("No dispatcher configured");
    expect(result.error.message).toContain("claude-sonnet-4.6");
  });

  it("propagates dispatcher failure", async () => {
    const result = await orchestrate(
      makeEvent({ source: "cli", action: "debug" }),
      makeConfig({ "deepseek-coder-v2": failingDispatcher("connection refused") }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("connection refused");
  });

  it("includes timing information in response", async () => {
    const result = await orchestrate(makeEvent({ source: "cli", action: "edit" }), makeConfig());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.timing.startedAt).toBeGreaterThan(0);
    expect(result.value.timing.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("passes empty string when payload.input is undefined", async () => {
    let capturedPrompt = "";
    const capturingDispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        capturedPrompt = req.prompt;
        return { ok: true, value: "ok" };
      },
    };

    await orchestrate(makeEvent({ source: "nvim", action: "edit" }), {
      dispatchers: { "qwen3:8b": capturingDispatcher },
    });

    expect(capturedPrompt).toBe("");
  });

  it("forwards llmOptions system, temperature and maxTokens to dispatcher", async () => {
    let capturedRequest: DispatchRequest | undefined;
    const capturingDispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        capturedRequest = req;
        return { ok: true, value: "ok" };
      },
    };

    const llmOptions: LLMOptions = {
      system: "You are a code generator.",
      temperature: 0.3,
      maxTokens: 512,
    };

    await orchestrate(
      makeEvent({ source: "nvim", action: "edit", payload: { input: "write code" } }),
      { dispatchers: { "qwen3:8b": capturingDispatcher } },
      llmOptions,
    );

    expect(capturedRequest?.system).toBe("You are a code generator.");
    expect(capturedRequest?.temperature).toBe(0.3);
    expect(capturedRequest?.maxTokens).toBe(512);
  });

  it("passes undefined llm fields when no llmOptions given", async () => {
    let capturedRequest: DispatchRequest | undefined;
    const capturingDispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        capturedRequest = req;
        return { ok: true, value: "ok" };
      },
    };

    await orchestrate(makeEvent({ source: "nvim", action: "edit" }), {
      dispatchers: { "qwen3:8b": capturingDispatcher },
    });

    expect(capturedRequest?.system).toBeUndefined();
    expect(capturedRequest?.temperature).toBeUndefined();
    expect(capturedRequest?.maxTokens).toBeUndefined();
  });
});
