import { describe, expect, it } from "bun:test";

import type { StepResult } from "@ai-coding/pipeline";
import type { PipelineContext } from "@ai-coding/pipeline";
import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { ResolvedSkill, RetrievalContext, SkillBackend } from "@ai-coding/skills";

import { COPILOT_DEFAULT_PROFILE } from "../../../config/model-profiles";
import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createCMakeDevCyclePipeline } from "./cmake-dev-cycle";

const STUB_CONFIG: OrchestratorConfig = { dispatchers: {} };

function capturingDispatcher(): ModelDispatcher & { lastPrompt: string; lastSystem: string } {
  const state = { lastPrompt: "", lastSystem: "" };
  const dispatcher: ModelDispatcher & { lastPrompt: string; lastSystem: string } = {
    get lastPrompt() {
      return state.lastPrompt;
    },
    get lastSystem() {
      return state.lastSystem;
    },
    dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
      state.lastPrompt = req.prompt;
      state.lastSystem = req.system ?? "";
      return { ok: true, value: "mock response" };
    },
  };
  return dispatcher;
}

function makeBackend(skills: readonly ResolvedSkill[]): SkillBackend {
  return {
    resolve: async (_ctx: RetrievalContext): Promise<readonly ResolvedSkill[]> => skills,
  };
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

function makeCtxWithResults(
  event: AIRequestEvent,
  entries: Record<string, string>,
): PipelineContext<AIRequestEvent> {
  const results = new Map<string, StepResult>(
    Object.entries(entries).map(([name, output]) => [
      name,
      { stepName: name, output, durationMs: 0 },
    ]),
  );
  return { event, results };
}

describe("createCMakeDevCyclePipeline", () => {
  it("returns exactly 6 steps when no skill backend is provided", () => {
    expect(createCMakeDevCyclePipeline(STUB_CONFIG, "/tmp/ws")).toHaveLength(6);
  });

  it("has step names in order: plan, implement, write-files, configure, build, test (no skills)", () => {
    const steps = createCMakeDevCyclePipeline(STUB_CONFIG, "/tmp/ws");
    expect(steps.map((s) => s.name)).toEqual([
      "plan",
      "implement",
      "write-files",
      "configure",
      "build",
      "test",
    ]);
  });

  it("returns 7 steps when a skill backend is provided", () => {
    const steps = createCMakeDevCyclePipeline(STUB_CONFIG, "/tmp/ws", "build", makeBackend([]));
    expect(steps).toHaveLength(7);
  });

  it("has resolve-skills as the first step when skill backend is provided", () => {
    const steps = createCMakeDevCyclePipeline(STUB_CONFIG, "/tmp/ws", "build", makeBackend([]));
    expect(steps[0]?.name).toBe("resolve-skills");
  });

  it("buildPrompt includes plan output and original request in implement step", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: COPILOT_DEFAULT_PROFILE,
      dispatchers: { "claude-sonnet-4.6": dispatcher },
    };
    const steps = createCMakeDevCyclePipeline(config, "/tmp/ws");
    const implementStep = steps[1];
    expect(implementStep).toBeDefined();
    if (!implementStep) return;

    const event = makeEvent("Add a matrix multiply function");
    const ctx = makeCtxWithResults(event, { plan: "Step 1: implement matmul.cpp" });
    await implementStep.execute(ctx);

    expect(dispatcher.lastPrompt).toContain("Step 1: implement matmul.cpp");
    expect(dispatcher.lastPrompt).toContain("Add a matrix multiply function");
    expect(dispatcher.lastPrompt).toContain("C++");
  });

  it("skill content is prepended to implement system prompt when skills resolve", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: COPILOT_DEFAULT_PROFILE,
      dispatchers: { "claude-sonnet-4.6": dispatcher },
    };
    const skills: ResolvedSkill[] = [{ name: "cpp", content: "Use C++20 idioms." }];
    const steps = createCMakeDevCyclePipeline(config, "/tmp/ws", "build", makeBackend(skills));

    // implement is at index 2 (after resolve-skills and plan)
    const implementStep = steps[2];
    if (!implementStep) return;

    const event = makeEvent("Add a matrix multiply function");
    const ctx = makeCtxWithResults(event, {
      "resolve-skills": "## Skill: cpp\n\nUse C++20 idioms.",
      plan: "Step 1: implement matmul.cpp",
    });
    await implementStep.execute(ctx);

    expect(dispatcher.lastSystem).toContain("## Skill: cpp");
    expect(dispatcher.lastSystem).toContain("Use C++20 idioms.");
    expect(dispatcher.lastSystem).toContain("fenced code blocks");
  });

  it("uses a custom build directory when provided", () => {
    const steps = createCMakeDevCyclePipeline(STUB_CONFIG, "/tmp/ws", "out");
    expect(steps).toHaveLength(6);
  });
});
