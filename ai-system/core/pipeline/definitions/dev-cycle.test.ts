import { describe, expect, it } from "bun:test";

import type { StepResult } from "@ai-coding/pipeline";
import type { PipelineContext } from "@ai-coding/pipeline";
import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { ResolvedSkill, RetrievalContext, SkillBackend } from "@ai-coding/skills";

import { COPILOT_DEFAULT_PROFILE } from "../../../config/model-profiles";
import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createDevCyclePipeline } from "./dev-cycle";

const STUB_CONFIG: OrchestratorConfig = { dispatchers: {} };

/** Mock dispatcher that captures the last prompt and system prompt it received. */
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
      return { ok: true, value: "```typescript src/index.ts\nconsole.log('hello');\n```" };
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

describe("createDevCyclePipeline", () => {
  it("returns exactly 4 steps when no skill backend is provided", () => {
    expect(createDevCyclePipeline(STUB_CONFIG)).toHaveLength(4);
  });

  it("has step names in order: plan, implement, write-files, test (no skills)", () => {
    const steps = createDevCyclePipeline(STUB_CONFIG);
    expect(steps.map((s) => s.name)).toEqual(["plan", "implement", "write-files", "test"]);
  });

  it("returns 5 steps when a skill backend is provided", () => {
    const steps = createDevCyclePipeline(STUB_CONFIG, "/tmp/ws", makeBackend([]));
    expect(steps).toHaveLength(5);
  });

  it("has resolve-skills as the first step when skill backend is provided", () => {
    const steps = createDevCyclePipeline(STUB_CONFIG, "/tmp/ws", makeBackend([]));
    expect(steps[0]?.name).toBe("resolve-skills");
  });

  it("has step names in order with skills: resolve-skills, plan, implement, write-files, test", () => {
    const steps = createDevCyclePipeline(STUB_CONFIG, "/tmp/ws", makeBackend([]));
    expect(steps.map((s) => s.name)).toEqual([
      "resolve-skills",
      "plan",
      "implement",
      "write-files",
      "test",
    ]);
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
    const ctx = makeCtxWithResults(event, { plan: "Step 1: handle errors gracefully" });
    await implementStep.execute(ctx);

    expect(dispatcher.lastPrompt).toContain("Step 1: handle errors gracefully");
    expect(dispatcher.lastPrompt).toContain("Add error handling");
  });

  it("implement step system prompt requires fenced code blocks with file paths", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: COPILOT_DEFAULT_PROFILE,
      dispatchers: { "claude-sonnet-4.6": dispatcher },
    };
    const steps = createDevCyclePipeline(config, "/tmp/ws");
    const implementStep = steps[1];
    if (!implementStep) return;

    const event = makeEvent("Add error handling");
    const ctx = makeCtxWithResults(event, { plan: "plan output" });
    await implementStep.execute(ctx);

    expect(dispatcher.lastSystem).toContain("fenced code blocks");
    expect(dispatcher.lastSystem).toContain("relative-file-path");
  });

  it("skill content is prepended to implement system prompt when skill backend resolves skills", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: COPILOT_DEFAULT_PROFILE,
      dispatchers: { "claude-sonnet-4.6": dispatcher },
    };
    const skills: ResolvedSkill[] = [{ name: "programmer", content: "Be a great programmer." }];
    const steps = createDevCyclePipeline(config, "/tmp/ws", makeBackend(skills));

    // implement is now at index 2 (after resolve-skills and plan)
    const implementStep = steps[2];
    if (!implementStep) return;

    const event = makeEvent("Add error handling");
    const ctx = makeCtxWithResults(event, {
      "resolve-skills": "## Skill: programmer\n\nBe a great programmer.",
      plan: "Step 1: handle errors",
    });
    await implementStep.execute(ctx);

    expect(dispatcher.lastSystem).toContain("## Skill: programmer");
    expect(dispatcher.lastSystem).toContain("Be a great programmer.");
    expect(dispatcher.lastSystem).toContain("fenced code blocks");
  });

  it("implement system prompt has no skill prefix when resolve-skills output is empty", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: COPILOT_DEFAULT_PROFILE,
      dispatchers: { "claude-sonnet-4.6": dispatcher },
    };
    const steps = createDevCyclePipeline(config, "/tmp/ws", makeBackend([]));
    const implementStep = steps[2];
    if (!implementStep) return;

    const event = makeEvent("Add error handling");
    const ctx = makeCtxWithResults(event, {
      "resolve-skills": "",
      plan: "Step 1: handle errors",
    });
    await implementStep.execute(ctx);

    expect(dispatcher.lastSystem).not.toContain("## Skill:");
    expect(dispatcher.lastSystem).toContain("fenced code blocks");
  });
});
