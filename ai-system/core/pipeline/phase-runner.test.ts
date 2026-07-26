import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import type { PipelineStep, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../config/model-profiles";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import type { DevCycleLanguageConfig, PlanConfigFactory } from "./definitions/language-configs";
import { BaselineCheckError, runPhase } from "./phase-runner";
import type { Phase } from "./plan-parser";
import type { ProgressEvent } from "./progress";

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
    sourceExtensions: [".ts"],
    sourceRoots: ["src"],
    toolchainSteps: (_workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      verifyStep(shouldFail, calls),
    ],
  };
}

function makeFactory(shouldFail: boolean, calls?: string[]): PlanConfigFactory {
  return () => languageConfig(shouldFail, calls);
}

/** Language config with a toolchain step that logs each invocation and can fail on the first call only. */
function baselineLanguageConfig(
  baselineCheck: boolean,
  failFirstCall: boolean,
  callLog: string[],
): DevCycleLanguageConfig {
  let callCount = 0;
  return {
    name: "typescript",
    implementSystem: "system",
    languageHint: "TypeScript",
    sourceExtensions: [".ts"],
    sourceRoots: ["src"],
    baselineCheck,
    toolchainSteps: (_workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      {
        name: "verify",
        execute: async (): Promise<Result<StepResult>> => {
          callCount += 1;
          callLog.push(`call-${callCount}`);
          if (failFirstCall && callCount === 1) {
            return { ok: false, error: new Error("baseline broken") };
          }
          return { ok: true, value: { stepName: "verify", output: "ok", durationMs: 0 } };
        },
      },
    ],
  };
}

function makeBaselineFactory(
  baselineCheck: boolean,
  failFirstCall: boolean,
  callLog: string[],
): PlanConfigFactory {
  return () => baselineLanguageConfig(baselineCheck, failFirstCall, callLog);
}

/** Model dispatcher that records how many times it was invoked. */
function countingDispatcher(response: string): {
  readonly dispatcher: ModelDispatcher;
  readonly callCount: () => number;
} {
  let count = 0;
  const modelDispatcher: ModelDispatcher = {
    dispatch: async (_request: DispatchRequest): Promise<Result<string>> => {
      count += 1;
      return { ok: true, value: response };
    },
  };
  return { dispatcher: modelDispatcher, callCount: () => count };
}

function config(response: string): OrchestratorConfig {
  // Convert code block response to aider-style patch format
  // Input: "```typescript src/index.ts\nexport const value = 1;\n```"
  // Output: "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE"
  const patchResponse = response
    .replace(/```typescript\s+/, "")
    .replace(/```\s*$/, "")
    .split("\n")
    .map((line, idx, arr) => {
      if (idx === 0) return line; // file path
      if (idx === 1) return "<<<<<<< SEARCH\n=======";
      if (idx === arr.length - 1) return ">>>>>>> REPLACE";
      return line;
    })
    .join("\n");

  const modelDispatcher = dispatcher(patchResponse);
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

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "phase-runner-test-"));
  // Initialize git repo for tests
  await $`git init`.cwd(workspace).quiet();
  await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
  await $`git config user.name "Test User"`.cwd(workspace).quiet();
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
      defaultLanguage: "typescript",
      factories: { typescript: makeFactory(false) },
      commitPhase: async (_workspace, message, _phaseNumber) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    if (!result.ok) {
      console.error("Phase failed:", result.error?.message);
    }
    expect(result.ok).toBe(true);
    expect(commits).toEqual(["feat: add core"]);
  });

  it("does not commit when phase verification fails", async () => {
    const commits: string[] = [];
    const result = await runPhase(PHASE, {
      config: config("```typescript src/index.ts\nexport const value = 1;\n```"),
      workspace,
      defaultLanguage: "typescript",
      factories: { typescript: makeFactory(true) },
      retryConfig: { maxLocalRetries: 0, maxEscalationRetries: 0 },
      commitPhase: async (_workspace, message, _phaseNumber) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(false);
    expect(commits).toEqual([]);
  });

  it("threads phaseNumber and onProgress through to the verified-implement step's events", async () => {
    const events: ProgressEvent[] = [];
    const result = await runPhase(PHASE, {
      config: config("```typescript src/index.ts\nexport const value = 1;\n```"),
      workspace,
      defaultLanguage: "typescript",
      factories: { typescript: makeFactory(false) },
      onProgress: (e) => events.push(e),
      commitPhase: async (_workspace, message, _phaseNumber) => ({ ok: true, value: message }),
    });

    expect(result.ok).toBe(true);
    // runPhase itself does not emit phase-start/finish (that's the feature
    // runner's job); it must forward phaseNumber/onProgress so the
    // verified-implement step's step-level events carry the right phase.
    expect(events).toEqual([
      { kind: "step-start", phase: 1, step: 1, title: "Step" },
      { kind: "step-finish", phase: 1, step: 1 },
    ]);
  });

  it("implements every phase step before running verification once", async () => {
    const commits: string[] = [];
    const verifyCalls: string[] = [];
    const prompts: string[] = [];
    let stepCount = 0;
    const modelDispatcher: ModelDispatcher = {
      dispatch: async (request: DispatchRequest): Promise<Result<string>> => {
        prompts.push(request.prompt);
        stepCount++;
        // First step creates the file, second step modifies it
        if (stepCount === 1) {
          return {
            ok: true,
            value:
              "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
          };
        }
        return {
          ok: true,
          value:
            "src/index.ts\n<<<<<<< SEARCH\nexport const value = 1;\n=======\nexport const value = 2;\n>>>>>>> REPLACE",
        };
      },
    };
    const result = await runPhase(MULTI_STEP_PHASE, {
      config: {
        profile: LOCAL_PROFILE,
        dispatchers: { "gemma4:26b": modelDispatcher },
      },
      workspace,
      defaultLanguage: "typescript",
      factories: { typescript: makeFactory(false, verifyCalls) },
      commitPhase: async (_workspace, message, _phaseNumber) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    if (!result.ok) {
      console.error("Phase failed:", result.error?.message);
    }
    expect(result.ok).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("Do one");
    expect(prompts[1]).toContain("Do two");
    expect(verifyCalls).toEqual(["verify"]);
    expect(commits).toEqual(["feat: add core"]);
  });

  it("skips baseline check when languageConfig.baselineCheck is unset", async () => {
    const callLog: string[] = [];
    const { dispatcher: modelDispatcher, callCount } = countingDispatcher(
      "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
    );
    const result = await runPhase(PHASE, {
      config: { profile: LOCAL_PROFILE, dispatchers: { "gemma4:26b": modelDispatcher } },
      workspace,
      defaultLanguage: "typescript",
      factories: { typescript: makeBaselineFactory(false, false, callLog) },
      commitPhase: async () => ({ ok: true, value: "" }),
    });

    expect(result.ok).toBe(true);
    // Only the post-implementation verification call, no baseline call.
    expect(callLog).toEqual(["call-1"]);
    expect(callCount()).toBe(1);
  });

  it("runs a baseline check before implement when baselineCheck is true, and proceeds when it passes", async () => {
    const callLog: string[] = [];
    const commits: string[] = [];
    const { dispatcher: modelDispatcher, callCount } = countingDispatcher(
      "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
    );
    const result = await runPhase(PHASE, {
      config: { profile: LOCAL_PROFILE, dispatchers: { "gemma4:26b": modelDispatcher } },
      workspace,
      defaultLanguage: "typescript",
      factories: { typescript: makeBaselineFactory(true, false, callLog) },
      commitPhase: async (_workspace, message) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(true);
    // Baseline call + post-implementation verification call.
    expect(callLog).toEqual(["call-1", "call-2"]);
    expect(callCount()).toBe(1);
    expect(commits).toEqual(["feat: add core"]);
  });

  it("halts with BaselineCheckError and skips implementation when the baseline check fails", async () => {
    const callLog: string[] = [];
    const commits: string[] = [];
    const { dispatcher: modelDispatcher, callCount } = countingDispatcher(
      "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
    );
    const result = await runPhase(PHASE, {
      config: { profile: LOCAL_PROFILE, dispatchers: { "gemma4:26b": modelDispatcher } },
      workspace,
      defaultLanguage: "typescript",
      factories: { typescript: makeBaselineFactory(true, true, callLog) },
      commitPhase: async (_workspace, message) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BaselineCheckError);
      expect(result.error.message).toContain("Baseline check failed");
      expect(result.error.message).toContain("before any implementation attempt");
    }
    // Baseline call only — verification (post-implement) never reached.
    expect(callLog).toEqual(["call-1"]);
    // The implementer was never invoked.
    expect(callCount()).toBe(0);
    expect(commits).toEqual([]);
  });
});
