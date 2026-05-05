import { describe, expect, it } from "bun:test";

import type { PipelineContext } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { ResolvedSkill, RetrievalContext, SkillBackend } from "@ai-coding/skills";

import { createSkillResolverStep } from "./skill-resolver-step";

function makeBackend(returns: readonly ResolvedSkill[]): SkillBackend {
  return {
    resolve: async (_ctx: RetrievalContext): Promise<readonly ResolvedSkill[]> => returns,
  };
}

function makeCapturingBackend(): SkillBackend & { lastContext: RetrievalContext | undefined } {
  const state: { lastContext: RetrievalContext | undefined } = { lastContext: undefined };
  return {
    get lastContext() {
      return state.lastContext;
    },
    resolve: async (ctx: RetrievalContext): Promise<readonly ResolvedSkill[]> => {
      state.lastContext = ctx;
      return [];
    },
  };
}

function makeEvent(overrides: Partial<AIRequestEvent["payload"]> = {}): AIRequestEvent {
  return {
    id: "test-id",
    timestamp: Date.now(),
    source: "cli",
    action: "edit",
    payload: { input: "do something", ...overrides },
  };
}

function makeCtx(event: AIRequestEvent): PipelineContext<AIRequestEvent> {
  return { event, results: new Map() };
}

describe("createSkillResolverStep", () => {
  it("returns a step with the given name", () => {
    const step = createSkillResolverStep("resolve-skills", makeBackend([]));
    expect(step.name).toBe("resolve-skills");
  });

  it("produces a successful StepResult", async () => {
    const step = createSkillResolverStep("resolve-skills", makeBackend([]));
    const result = await step.execute(makeCtx(makeEvent()));
    expect(result.ok).toBe(true);
  });

  it("stores merged skill content as output", async () => {
    const skills: ResolvedSkill[] = [{ name: "programmer", content: "You are an engineer." }];
    const step = createSkillResolverStep("resolve-skills", makeBackend(skills));
    const result = await step.execute(makeCtx(makeEvent()));
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.output).toContain("## Skill: programmer");
    expect(result.value.output).toContain("You are an engineer.");
  });

  it("produces empty output when no skills resolve", async () => {
    const step = createSkillResolverStep("resolve-skills", makeBackend([]));
    const result = await step.execute(makeCtx(makeEvent()));
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.output).toBe("");
  });

  it("passes event action to the backend context", async () => {
    const backend = makeCapturingBackend();
    const event: AIRequestEvent = { ...makeEvent(), action: "debug" };
    const step = createSkillResolverStep("resolve-skills", backend);
    await step.execute(makeCtx(event));
    expect(backend.lastContext?.action).toBe("debug");
  });

  it("passes event payload workspace to the backend context", async () => {
    const backend = makeCapturingBackend();
    const event = makeEvent({ workspace: "/my/project" });
    const step = createSkillResolverStep("resolve-skills", backend);
    await step.execute(makeCtx(event));
    expect(backend.lastContext?.workspace).toBe("/my/project");
  });

  it("passes undefined workspace when payload has no workspace", async () => {
    const backend = makeCapturingBackend();
    const step = createSkillResolverStep("resolve-skills", backend);
    await step.execute(makeCtx(makeEvent()));
    expect(backend.lastContext?.workspace).toBeUndefined();
  });

  it("step name matches StepResult.stepName", async () => {
    const step = createSkillResolverStep("my-skills", makeBackend([]));
    const result = await step.execute(makeCtx(makeEvent()));
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.stepName).toBe("my-skills");
  });

  it("records a non-negative durationMs", async () => {
    const step = createSkillResolverStep("resolve-skills", makeBackend([]));
    const result = await step.execute(makeCtx(makeEvent()));
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });
});
