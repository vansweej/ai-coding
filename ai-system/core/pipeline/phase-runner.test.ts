import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { PipelineStep, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../config/model-profiles";
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

function verifyStep(shouldFail: boolean, calls?: string[]): PipelineStep<AIRequestEvent> {
  return {
    name: "verify",
    execute: async (): Promise<Result<StepResult>> => {
      calls?.push("verify");
      if (shouldFail) return { ok: false, error: new Error("verification failed") };
      return { ok: true, value: { stepName: "verify", output: "ok", durationMs: 0 } };
    },
  };
}

function languageConfig(shouldFail: boolean, calls?: string[]): DevCycleLanguageConfig {
  return {
    name: "typescript",
    implementSystem: "system",
    languageHint: "TypeScript",
    toolchainSteps: (_workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      verifyStep(shouldFail, calls),
    ],
  };
}

function config(response: string): OrchestratorConfig {
  const modelDispatcher = dispatcher(response);
  return {
    profile: LOCAL_PROFILE,
    dispatchers: { "gemma4:26b": modelDispatcher },
  };
}

const PHASE: Phase = {
  number: 1,
  title: "Core",
  commitMessage: "feat: add core",
  steps: [{ number: 1, title: "Step", body: "Do it" }],
  coverage: { mode: "default" },
};

const MULTI_STEP_PHASE: Phase = {
  number: 1,
  title: "Core",
  commitMessage: "feat: add core",
  steps: [
    { number: 1, title: "Step one", body: "Do one" },
    { number: 2, title: "Step two", body: "Do two" },
  ],
  coverage: { mode: "default" },
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

  it("implements every phase step before running verification once", async () => {
    const commits: string[] = [];
    const verifyCalls: string[] = [];
    const prompts: string[] = [];
    const modelDispatcher: ModelDispatcher = {
      dispatch: async (request: DispatchRequest): Promise<Result<string>> => {
        prompts.push(request.prompt);
        return {
          ok: true,
          value: "```typescript src/index.ts\nexport const value = 1;\n```",
        };
      },
    };
    const result = await runPhase(MULTI_STEP_PHASE, {
      config: {
        profile: LOCAL_PROFILE,
        dispatchers: { "gemma4:26b": modelDispatcher },
      },
      workspace,
      languageConfig: languageConfig(false, verifyCalls),
      commitPhase: async (_workspace, message) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Do one");
    expect(prompts[1]).toContain("Do two");
    expect(verifyCalls).toEqual(["verify"]);
    expect(commits).toEqual(["feat: add core"]);
  });
});
