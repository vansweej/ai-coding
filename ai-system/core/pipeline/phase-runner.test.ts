import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { PipelineStep, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { HYBRID_PROFILE } from "../../config/model-profiles";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "./definitions/language-configs";
import { runPhase } from "./phase-runner";
import type { Phase } from "./plan-parser";

function dispatcher(response: string): ModelDispatcher {
  return {
    dispatch: async (_request: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: response,
    }),
  };
}

function verifyStep(shouldFail: boolean): PipelineStep<AIRequestEvent> {
  return {
    name: "verify",
    execute: async (): Promise<Result<StepResult>> => {
      if (shouldFail) return { ok: false, error: new Error("verification failed") };
      return { ok: true, value: { stepName: "verify", output: "ok", durationMs: 0 } };
    },
  };
}

function languageConfig(shouldFail: boolean): DevCycleLanguageConfig {
  return {
    name: "typescript",
    implementSystem: "system",
    languageHint: "TypeScript",
    toolchainSteps: (_workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      verifyStep(shouldFail),
    ],
  };
}

function config(response: string): OrchestratorConfig {
  const modelDispatcher = dispatcher(response);
  return {
    profile: HYBRID_PROFILE,
    dispatchers: { "gemma4:26b": modelDispatcher, "claude-sonnet-4.6": modelDispatcher },
  };
}

const PHASE: Phase = {
  number: 1,
  title: "Core",
  commitMessage: "feat: add core",
  steps: [{ number: 1, title: "Step", body: "Do it" }],
};

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "phase-runner-test-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("runPhase", () => {
  it("commits after a successful phase", async () => {
    const commits: string[] = [];
    const result = await runPhase(PHASE, {
      config: config("```typescript src/index.ts\nexport const value = 1;\n```"),
      workspace,
      languageConfig: languageConfig(false),
      commitPhase: async (_workspace, message) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(true);
    expect(commits).toEqual(["feat: add core"]);
  });

  it("does not commit when phase verification fails", async () => {
    const commits: string[] = [];
    const result = await runPhase(PHASE, {
      config: config("```typescript src/index.ts\nexport const value = 1;\n```"),
      workspace,
      languageConfig: languageConfig(true),
      retryConfig: { maxLocalRetries: 0, maxEscalationRetries: 0 },
      commitPhase: async (_workspace, message) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(false);
    expect(commits).toEqual([]);
  });
});
