import { describe, expect, it } from "bun:test";

import type { StepResult } from "@ai-coding/pipeline";
import type { PipelineContext } from "@ai-coding/pipeline";
import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { ResolvedSkill, RetrievalContext, SkillBackend } from "@ai-coding/skills";

import { LOCAL_PROFILE } from "../../../config/model-profiles";
import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createDevCyclePipeline } from "./dev-cycle";
import { TYPESCRIPT_CONFIG } from "./language-configs";

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
  it("returns exactly 2 steps when no skill backend is provided", () => {
    expect(createDevCyclePipeline(STUB_CONFIG)).toHaveLength(2);
  });

  it("has step names in order: implement, write-files (no skills)", () => {
    const steps = createDevCyclePipeline(STUB_CONFIG);
    expect(steps.map((s) => s.name)).toEqual(["implement", "write-files"]);
  });

  it("returns 3 steps when a skill backend is provided", () => {
    const steps = createDevCyclePipeline(
      STUB_CONFIG,
      "/tmp/ws",
      TYPESCRIPT_CONFIG,
      makeBackend([]),
    );
    expect(steps).toHaveLength(3);
  });

  it("has resolve-skills as the first step when skill backend is provided", () => {
    const steps = createDevCyclePipeline(
      STUB_CONFIG,
      "/tmp/ws",
      TYPESCRIPT_CONFIG,
      makeBackend([]),
    );
    expect(steps[0]?.name).toBe("resolve-skills");
  });

  it("has step names in order with skills: resolve-skills, implement, write-files", () => {
    const steps = createDevCyclePipeline(
      STUB_CONFIG,
      "/tmp/ws",
      TYPESCRIPT_CONFIG,
      makeBackend([]),
    );
    expect(steps.map((s) => s.name)).toEqual(["resolve-skills", "implement", "write-files"]);
  });

  it("buildPrompt includes the step instruction in the implement step", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher },
    };
    const steps = createDevCyclePipeline(config, "/tmp/ws");
    const implementStep = steps[0];
    expect(implementStep).toBeDefined();
    if (!implementStep) return;

    const event = makeEvent("Add error handling");
    const ctx = makeCtxWithResults(event, {});
    await implementStep.execute(ctx);

    expect(dispatcher.lastPrompt).toContain("Add error handling");
    expect(dispatcher.lastPrompt).toContain("TypeScript");
  });

  it("implement step system prompt requires fenced code blocks with file paths", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher },
    };
    const steps = createDevCyclePipeline(config, "/tmp/ws");
    const implementStep = steps[0];
    if (!implementStep) return;

    const event = makeEvent("Add error handling");
    const ctx = makeCtxWithResults(event, {});
    await implementStep.execute(ctx);

    expect(dispatcher.lastSystem).toContain("fenced code blocks");
    expect(dispatcher.lastSystem).toContain("relative-file-path");
  });

  it("skill content is prepended to implement system prompt when skill backend resolves skills", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher },
    };
    const skills: ResolvedSkill[] = [{ name: "programmer", content: "Be a great programmer." }];
    const steps = createDevCyclePipeline(config, "/tmp/ws", TYPESCRIPT_CONFIG, makeBackend(skills));

    // implement is now at index 1 (after resolve-skills)
    const implementStep = steps[1];
    if (!implementStep) return;

    const event = makeEvent("Add error handling");
    const ctx = makeCtxWithResults(event, {
      "resolve-skills": "## Skill: programmer\n\nBe a great programmer.",
    });
    await implementStep.execute(ctx);

    expect(dispatcher.lastSystem).toContain("## Skill: programmer");
    expect(dispatcher.lastSystem).toContain("Be a great programmer.");
    expect(dispatcher.lastSystem).toContain("fenced code blocks");
  });

  it("implement system prompt has no skill prefix when resolve-skills output is empty", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher },
    };
    const steps = createDevCyclePipeline(config, "/tmp/ws", TYPESCRIPT_CONFIG, makeBackend([]));
    const implementStep = steps[1];
    if (!implementStep) return;

    const event = makeEvent("Add error handling");
    const ctx = makeCtxWithResults(event, {
      "resolve-skills": "",
    });
    await implementStep.execute(ctx);

    expect(dispatcher.lastSystem).not.toContain("## Skill:");
    expect(dispatcher.lastSystem).toContain("fenced code blocks");
  });
});
