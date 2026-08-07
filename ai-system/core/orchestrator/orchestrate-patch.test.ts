import { describe, expect, it } from "bun:test";

import type {
  AIRequestEvent,
  DispatchRequest,
  ModelDispatcher,
  PatchOp,
  Result,
} from "@ai-coding/shared";

import type { CerebrumMemory } from "./cerebrum-memory";
import type { OrchestratorConfig } from "./orchestrate";
import { orchestratePatch } from "./orchestrate";

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

const SAMPLE_OPS: readonly PatchOp[] = [
  { kind: "create", filePath: "src/new.ts", contents: "export {}" },
];

/** A dispatcher WITHOUT dispatchPatch -- structurally "not capable". */
function textOnlyDispatcher(): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "text-response",
    }),
  };
}

/** A dispatcher WITH dispatchPatch returning a fixed ops array. */
function structuredDispatcher(ops: readonly PatchOp[]): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "unused",
    }),
    dispatchPatch: async (_req: DispatchRequest): Promise<Result<readonly PatchOp[]>> => ({
      ok: true,
      value: ops,
    }),
  };
}

/** A dispatcher WITH dispatchPatch that always fails. */
function failingStructuredDispatcher(message: string): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "unused",
    }),
    dispatchPatch: async (_req: DispatchRequest): Promise<Result<readonly PatchOp[]>> => ({
      ok: false,
      error: new Error(message),
    }),
  };
}

describe("orchestratePatch", () => {
  it("returns not-capable for a text-mode model-ID (e.g. gemma4:26b, default text)", async () => {
    const config: OrchestratorConfig = {
      dispatchers: { "gemma4:26b": structuredDispatcher(SAMPLE_OPS) },
    };

    const result = await orchestratePatch(makeEvent({ source: "cli", action: "edit" }), config);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kind: "not-capable" });
    }
  });

  it("returns not-capable when the resolved dispatcher lacks dispatchPatch", async () => {
    const config: OrchestratorConfig = {
      profile: {
        name: "anthropic-sonnet",
        roles: {
          planner: "claude-sonnet-5",
          implementer: "claude-sonnet-5",
          debugger: "claude-sonnet-5",
          fixer: "claude-sonnet-5",
          reviewer: "claude-sonnet-5",
          tester: "claude-sonnet-5",
          scaffolder: "claude-sonnet-5",
          explorer: "claude-sonnet-5",
          default: "claude-sonnet-5",
        },
      },
      dispatchers: { "claude-sonnet-5": textOnlyDispatcher() },
    };

    const result = await orchestratePatch(makeEvent({ source: "cli", action: "edit" }), config);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kind: "not-capable" });
    }
  });

  it("returns structured ops and fires the memory side-effect for claude-sonnet-5", async () => {
    let rememberedContent: string | undefined;
    const fakeMemory = {
      remember: async (content: string, _salience?: number): Promise<Result<string>> => {
        rememberedContent = content;
        return { ok: true, value: "mem-id" };
      },
    } as unknown as CerebrumMemory;

    const config: OrchestratorConfig = {
      profile: {
        name: "anthropic-sonnet",
        roles: {
          planner: "claude-sonnet-5",
          implementer: "claude-sonnet-5",
          debugger: "claude-sonnet-5",
          fixer: "claude-sonnet-5",
          reviewer: "claude-sonnet-5",
          tester: "claude-sonnet-5",
          scaffolder: "claude-sonnet-5",
          explorer: "claude-sonnet-5",
          default: "claude-sonnet-5",
        },
      },
      dispatchers: { "claude-sonnet-5": structuredDispatcher(SAMPLE_OPS) },
      memory: fakeMemory,
    };

    const result = await orchestratePatch(
      makeEvent({ source: "cli", action: "edit", payload: { input: "do the thing" } }),
      config,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kind: "structured", ops: SAMPLE_OPS });
    }
    expect(rememberedContent).toBeDefined();
    expect(rememberedContent).toContain("claude-sonnet-5");
  });

  it("propagates a dispatchPatch error", async () => {
    const config: OrchestratorConfig = {
      profile: {
        name: "anthropic-sonnet",
        roles: {
          planner: "claude-sonnet-5",
          implementer: "claude-sonnet-5",
          debugger: "claude-sonnet-5",
          fixer: "claude-sonnet-5",
          reviewer: "claude-sonnet-5",
          tester: "claude-sonnet-5",
          scaffolder: "claude-sonnet-5",
          explorer: "claude-sonnet-5",
          default: "claude-sonnet-5",
        },
      },
      dispatchers: { "claude-sonnet-5": failingStructuredDispatcher("truncated tool call") },
    };

    const result = await orchestratePatch(makeEvent({ source: "cli", action: "edit" }), config);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("truncated tool call");
    }
  });

  it("returns error when no dispatcher is configured for the resolved model", async () => {
    const config: OrchestratorConfig = { dispatchers: {} };

    const result = await orchestratePatch(makeEvent({ source: "cli", action: "plan" }), config);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("No dispatcher configured");
    }
  });

  it("recomputes capability per call under a HYBRID-shaped profile mixing model-IDs", async () => {
    const hybridLikeProfile = {
      name: "hybrid",
      roles: {
        planner: "claude-sonnet-4.6",
        implementer: "gemma4:26b",
        debugger: "gemma4:26b",
        fixer: "claude-sonnet-5",
        reviewer: "claude-sonnet-4.6",
        tester: "gemma4:26b",
        scaffolder: "claude-sonnet-4.6",
        explorer: "claude-sonnet-4.6",
        default: "claude-sonnet-4.6",
      },
    };

    const config: OrchestratorConfig = {
      profile: hybridLikeProfile,
      dispatchers: {
        "gemma4:26b": structuredDispatcher(SAMPLE_OPS),
        "claude-sonnet-5": structuredDispatcher(SAMPLE_OPS),
      },
    };

    // "edit" -> implementer -> gemma4:26b, text-default -> not-capable
    const editResult = await orchestratePatch(makeEvent({ source: "cli", action: "edit" }), config);
    expect(editResult.ok).toBe(true);
    if (editResult.ok) {
      expect(editResult.value).toEqual({ kind: "not-capable" });
    }

    // "fix" -> fixer -> claude-sonnet-5, anthropic-tool-use -> structured
    const fixResult = await orchestratePatch(makeEvent({ source: "cli", action: "fix" }), config);
    expect(fixResult.ok).toBe(true);
    if (fixResult.ok) {
      expect(fixResult.value).toEqual({ kind: "structured", ops: SAMPLE_OPS });
    }
  });
});
