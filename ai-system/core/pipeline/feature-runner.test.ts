import { describe, expect, it } from "bun:test";

import type { PipelineStep, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { HYBRID_PROFILE } from "../../config/model-profiles";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "./definitions/language-configs";
import { runFeature } from "./feature-runner";

const PLAN = `# Feature: Demo

## Phase 1: One

Commit message: feat: one

### Step 1: Implement one

Do one.

## Phase 2: Two

Commit message: feat: two

### Step 1: Implement two

Do two.
`;

function config(): OrchestratorConfig {
  const dispatcher: ModelDispatcher = {
    dispatch: async (_request: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "```typescript src/index.ts\nexport const value = 1;\n```",
    }),
  };
  return {
    profile: HYBRID_PROFILE,
    dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
  };
}

function languageConfig(): DevCycleLanguageConfig {
  return {
    name: "typescript",
    implementSystem: "system",
    languageHint: "TypeScript",
    toolchainSteps: (_workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      {
        name: "verify",
        execute: async (): Promise<Result<StepResult>> => ({
          ok: true,
          value: { stepName: "verify", output: "ok", durationMs: 0 },
        }),
      },
    ],
  };
}

describe("runFeature", () => {
  it("runs multiple phases sequentially", async () => {
    const commits: string[] = [];
    const result = await runFeature(PLAN, {
      config: config(),
      workspace: "/tmp",
      languageConfig: languageConfig(),
      commitPhase: async (_workspace, message) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.phases).toHaveLength(2);
    expect(commits).toEqual(["feat: one", "feat: two"]);
  });

  it("stops on first failed phase and preserves earlier commits", async () => {
    const commits: string[] = [];
    const result = await runFeature(PLAN, {
      config: config(),
      workspace: "/tmp",
      languageConfig: languageConfig(),
      commitPhase: async (_workspace, message) => {
        commits.push(message);
        if (message === "feat: two") return { ok: false, error: new Error("commit failed") };
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(false);
    expect(commits).toEqual(["feat: one", "feat: two"]);
  });
});
