import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { PipelineStep, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { HYBRID_PROFILE } from "../../../config/model-profiles";
import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "../definitions/language-configs";
import {
  buildVerificationFailurePrompt,
  createVerifiedImplementStep,
} from "./verified-implement-step";

function makeEvent(input: string): AIRequestEvent {
  return {
    id: "test",
    timestamp: Date.now(),
    source: "cli",
    action: "task",
    payload: { input },
  };
}

function sequenceDispatcher(
  responses: readonly string[],
): ModelDispatcher & { readonly prompts: readonly string[] } {
  const prompts: string[] = [];
  let index = 0;
  return {
    get prompts() {
      return prompts;
    },
    dispatch: async (request: DispatchRequest): Promise<Result<string>> => {
      prompts.push(request.prompt);
      const response = responses[index] ?? responses[responses.length - 1] ?? "";
      index += 1;
      return { ok: true, value: response };
    },
  };
}

function verificationStep(failuresBeforeSuccess: number): PipelineStep<AIRequestEvent> {
  let calls = 0;
  return {
    name: "verify",
    execute: async (): Promise<Result<StepResult>> => {
      calls += 1;
      if (calls <= failuresBeforeSuccess) {
        return { ok: false, error: new Error(`compile error ${calls}`) };
      }
      return { ok: true, value: { stepName: "verify", output: "ok", durationMs: 0 } };
    },
  };
}

function makeLanguageConfig(step: PipelineStep<AIRequestEvent>): DevCycleLanguageConfig {
  return {
    name: "typescript",
    implementSystem: "system prompt",
    languageHint: "TypeScript",
    toolchainSteps: (_workspace: string): readonly PipelineStep<AIRequestEvent>[] => [step],
  };
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "verified-implement-test-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("createVerifiedImplementStep", () => {
  it("writes code and succeeds on the happy path", async () => {
    const dispatcher = sequenceDispatcher([
      "```typescript src/index.ts\nexport const value = 1;\n```",
    ]);
    const config: OrchestratorConfig = {
      profile: HYBRID_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(0)),
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toBe("export const value = 1;");
  });

  it("retries locally with verification diagnostics", async () => {
    const dispatcher = sequenceDispatcher([
      "```typescript src/index.ts\nexport const value = 'bad';\n```",
      "```typescript src/index.ts\nexport const value = 1;\n```",
    ]);
    const config: OrchestratorConfig = {
      profile: HYBRID_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(1)),
      retryConfig: { maxLocalRetries: 1, maxEscalationRetries: 0 },
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(dispatcher.prompts[1]).toContain("compile error 1");
    expect(dispatcher.prompts[1]).toContain("Previously written code");
  });

  it("escalates to fixer after local retries are exhausted", async () => {
    const localDispatcher = sequenceDispatcher([
      "```typescript src/index.ts\nexport const value = 'bad';\n```",
    ]);
    const fixerDispatcher = sequenceDispatcher([
      "```typescript src/index.ts\nexport const value = 1;\n```",
    ]);
    const config: OrchestratorConfig = {
      profile: HYBRID_PROFILE,
      dispatchers: { "gemma4:26b": localDispatcher, "claude-sonnet-4.6": fixerDispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(1)),
      retryConfig: { maxLocalRetries: 0, maxEscalationRetries: 1 },
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(fixerDispatcher.prompts).toHaveLength(1);
    expect(fixerDispatcher.prompts[0]).toContain("compile error 1");
  });

  it("halts with diagnostics after retry limits are exhausted", async () => {
    const dispatcher = sequenceDispatcher([
      "```typescript src/index.ts\nexport const value = 'bad';\n```",
    ]);
    const config: OrchestratorConfig = {
      profile: HYBRID_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(10)),
      retryConfig: { maxLocalRetries: 1, maxEscalationRetries: 1 },
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("failed after 2 local attempt");
      expect(result.error.message).toContain("compile error");
    }
  });
});

describe("buildVerificationFailurePrompt", () => {
  it("includes original instructions, written code, and error output", () => {
    const prompt = buildVerificationFailurePrompt("do it", "code", "error");
    expect(prompt).toContain("do it");
    expect(prompt).toContain("code");
    expect(prompt).toContain("error");
  });
});
