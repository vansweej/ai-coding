import { describe, expect, it } from "bun:test";

import type { StepResult } from "@ai-coding/pipeline";
import type { PipelineContext } from "@ai-coding/pipeline";
import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { ResolvedSkill, RetrievalContext, SkillBackend } from "@ai-coding/skills";

import { COPILOT_DEFAULT_PROFILE } from "../../../config/model-profiles";
import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createRustDevCyclePipeline } from "./rust-dev-cycle";

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
      return { ok: true, value: "```rust src/lib.rs\npub fn hello() {}\n```" };
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

describe("createRustDevCyclePipeline", () => {
  it("returns exactly 8 steps when no skill backend is provided", () => {
    expect(createRustDevCyclePipeline(STUB_CONFIG, "/tmp/ws")).toHaveLength(8);
  });

  it("has step names in order (no skills)", () => {
    const steps = createRustDevCyclePipeline(STUB_CONFIG, "/tmp/ws");
    expect(steps.map((s) => s.name)).toEqual([
      "plan",
      "implement",
      "write-files",
      "fmt",
      "clippy",
      "test",
      "tarpaulin",
      "coverage",
    ]);
  });

  it("returns 9 steps when a skill backend is provided", () => {
    const steps = createRustDevCyclePipeline(STUB_CONFIG, "/tmp/ws", 90, makeBackend([]));
    expect(steps).toHaveLength(9);
  });

  it("has resolve-skills as the first step when skill backend is provided", () => {
    const steps = createRustDevCyclePipeline(STUB_CONFIG, "/tmp/ws", 90, makeBackend([]));
    expect(steps[0]?.name).toBe("resolve-skills");
  });

  it("buildPrompt includes plan output and original request in implement step", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: COPILOT_DEFAULT_PROFILE,
      dispatchers: { "claude-sonnet-4.6": dispatcher },
    };
    const steps = createRustDevCyclePipeline(config, "/tmp/ws");
    const implementStep = steps[1];
    expect(implementStep).toBeDefined();
    if (!implementStep) return;

    const event = makeEvent("Add a parser module");
    const ctx = makeCtxWithResults(event, { plan: "Step 1: create parser.rs" });
    await implementStep.execute(ctx);

    expect(dispatcher.lastPrompt).toContain("Step 1: create parser.rs");
    expect(dispatcher.lastPrompt).toContain("Add a parser module");
    expect(dispatcher.lastPrompt).toContain("Rust");
  });

  it("implement step system prompt requires fenced code blocks with file paths", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: COPILOT_DEFAULT_PROFILE,
      dispatchers: { "claude-sonnet-4.6": dispatcher },
    };
    const steps = createRustDevCyclePipeline(config, "/tmp/ws");
    const implementStep = steps[1];
    if (!implementStep) return;

    const event = makeEvent("Add a parser module");
    const ctx = makeCtxWithResults(event, { plan: "plan output" });
    await implementStep.execute(ctx);

    expect(dispatcher.lastSystem).toContain("fenced code blocks");
    expect(dispatcher.lastSystem).toContain("relative-file-path");
  });

  it("skill content is prepended to implement system prompt when skills resolve", async () => {
    const dispatcher = capturingDispatcher();
    const config: OrchestratorConfig = {
      profile: COPILOT_DEFAULT_PROFILE,
      dispatchers: { "claude-sonnet-4.6": dispatcher },
    };
    const skills: ResolvedSkill[] = [{ name: "rust", content: "Use idiomatic Rust." }];
    const steps = createRustDevCyclePipeline(config, "/tmp/ws", 90, makeBackend(skills));

    // implement is at index 2 (after resolve-skills and plan)
    const implementStep = steps[2];
    if (!implementStep) return;

    const event = makeEvent("Add a parser module");
    const ctx = makeCtxWithResults(event, {
      "resolve-skills": "## Skill: rust\n\nUse idiomatic Rust.",
      plan: "Step 1: create parser.rs",
    });
    await implementStep.execute(ctx);

    expect(dispatcher.lastSystem).toContain("## Skill: rust");
    expect(dispatcher.lastSystem).toContain("Use idiomatic Rust.");
    expect(dispatcher.lastSystem).toContain("fenced code blocks");
  });

  it("uses the custom coverage threshold when provided", () => {
    const steps = createRustDevCyclePipeline(STUB_CONFIG, "/tmp/ws", 80);
    expect(steps).toHaveLength(8);
  });
});
