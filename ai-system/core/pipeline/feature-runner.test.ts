import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

import type { PipelineStep, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../config/model-profiles";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import type { DevCycleLanguageConfig, PlanConfigFactory } from "./definitions/language-configs";
import { runFeature } from "./feature-runner";
import type { ProgressEvent } from "./progress";

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
  let requestCount = 0;
  const dispatcher: ModelDispatcher = {
    dispatch: async (_request: DispatchRequest): Promise<Result<string>> => {
      requestCount++;
      // First request (Phase 1): create the file
      if (requestCount === 1) {
        return {
          ok: true,
          value: "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
        };
      }
      // Second request (Phase 2): modify the existing file
      return {
        ok: true,
        value:
          "src/index.ts\n<<<<<<< SEARCH\nexport const value = 1;\n=======\nexport const value = 2;\n>>>>>>> REPLACE",
      };
    },
  };
  return {
    profile: LOCAL_PROFILE,
    dispatchers: { "gemma4:26b": dispatcher },
  };
}

function languageConfig(): DevCycleLanguageConfig {
  return {
    name: "typescript",
    implementSystem: "system",
    languageHint: "TypeScript",
    sourceExtensions: [".ts"],
    sourceRoots: ["src"],
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

const testFactory: PlanConfigFactory = () => languageConfig();

let workspace: string;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "feature-runner-test-"));
  // Initialize git repo for tests
  await $`git init`.cwd(workspace).quiet();
  await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
  await $`git config user.name "Test User"`.cwd(workspace).quiet();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("runFeature", () => {
  it("runs multiple phases sequentially", async () => {
    const commits: string[] = [];
    const result = await runFeature(PLAN, {
      config: config(),
      workspace,
      defaultLanguage: "typescript",
      factories: { typescript: testFactory },
      commitPhase: async (_workspace, message, _phaseNumber) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    if (!result.ok) {
      console.error("Feature failed:", result.error?.message);
    }
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.phases).toHaveLength(2);
    expect(commits).toEqual(["feat: one", "feat: two"]);
  });

  it("stops on first failed phase and preserves earlier commits", async () => {
    const commits: string[] = [];
    const result = await runFeature(PLAN, {
      config: config(),
      workspace,
      defaultLanguage: "typescript",
      factories: { typescript: testFactory },
      commitPhase: async (_workspace, message, _phaseNumber) => {
        commits.push(message);
        if (message === "feat: two") return { ok: false, error: new Error("commit failed") };
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(false);
    expect(commits).toEqual(["feat: one", "feat: two"]);
  });

  it("emits phase-start/phase-finish for a passing phase and phase-fail for a failing one", async () => {
    const events: ProgressEvent[] = [];
    const result = await runFeature(PLAN, {
      config: config(),
      workspace,
      defaultLanguage: "typescript",
      factories: { typescript: testFactory },
      onProgress: (e) => events.push(e),
      commitPhase: async (_workspace, message, _phaseNumber) => {
        if (message === "feat: two") return { ok: false, error: new Error("commit failed") };
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(false);
    expect(events).toEqual([
      { kind: "phase-start", phase: 1, title: "One" },
      { kind: "step-start", phase: 1, step: 1, title: "Implement one" },
      { kind: "step-finish", phase: 1, step: 1 },
      { kind: "phase-finish", phase: 1, commitMessage: "feat: one" },
      { kind: "phase-start", phase: 2, title: "Two" },
      { kind: "step-start", phase: 2, step: 1, title: "Implement two" },
      { kind: "step-finish", phase: 2, step: 1 },
      { kind: "phase-fail", phase: 2, reason: "commit failed" },
    ]);
  });
});
