import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { PipelineStep, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../../config/model-profiles";
import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "../definitions/language-configs";
import type { Step } from "../plan-parser";
import {
  buildBaselineContext,
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

/**
 * A verification step that reflects the ACTUAL on-disk content of a file,
 * unlike `verificationStep` above (which passes/fails purely by call count).
 * Used for tests that must distinguish "verification re-run against
 * unchanged, still-broken code" from "verification passing because the
 * code was genuinely fixed" -- a real toolchain (e.g. `cargo test`) is
 * deterministic against file content, so re-running it against unchanged
 * broken code must keep failing.
 */
function contentCheckingVerificationStep(
  filePath: string,
  expectedContent: string,
): PipelineStep<AIRequestEvent> {
  return {
    name: "verify",
    execute: async (): Promise<Result<StepResult>> => {
      let actual: string;
      try {
        actual = readFileSync(filePath, "utf8");
      } catch {
        return { ok: false, error: new Error("file not found") };
      }
      if (actual !== expectedContent) {
        return { ok: false, error: new Error(`expected "${expectedContent}", got "${actual}"`) };
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
    sourceExtensions: [".ts"],
    sourceRoots: ["src"],
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
      profile: LOCAL_PROFILE,
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
      profile: LOCAL_PROFILE,
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
    const dispatcher = sequenceDispatcher([
      "```typescript src/index.ts\nexport const value = 'bad';\n```",
      "```typescript src/index.ts\nexport const value = 1;\n```",
    ]);
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(1)),
      retryConfig: { maxLocalRetries: 0, maxEscalationRetries: 1 },
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(dispatcher.prompts).toHaveLength(2);
    expect(dispatcher.prompts[1]).toContain("compile error 1");
  });

  it("halts with diagnostics after retry limits are exhausted", async () => {
    const dispatcher = sequenceDispatcher([
      "```typescript src/index.ts\nexport const value = 'bad';\n```",
    ]);
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
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

  it("recovers in the local loop when the model returns prose instead of a patch on the first attempt", async () => {
    const dispatcher = sequenceDispatcher([
      "I need to see the current contents of src/index.ts to make the correct patch.",
      "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
    ]);
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(0)),
      retryConfig: { maxLocalRetries: 1, maxEscalationRetries: 0 },
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toBe("export const value = 1;");
    // The corrective re-prompt must carry the parse failure back to the model.
    expect(dispatcher.prompts[1]).toContain("is missing");
    expect(dispatcher.prompts[1]).toContain("SEARCH");
  });

  it("recovers in the escalation loop when the fixer returns prose instead of a patch on its first attempt", async () => {
    const dispatcher = sequenceDispatcher([
      "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 'bad';\n>>>>>>> REPLACE",
      "Let me look at the current file before proposing a fix.",
      "src/index.ts\n<<<<<<< SEARCH\nexport const value = 'bad';\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
    ]);
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher },
    };
    // Content-aware verification: passes only once the file actually
    // contains the fixed value, so a prose ("no changes") response that
    // leaves the file at its still-broken content cannot cause a false
    // pass on re-verification.
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(
        contentCheckingVerificationStep(join(workspace, "src/index.ts"), "export const value = 1;"),
      ),
      retryConfig: { maxLocalRetries: 0, maxEscalationRetries: 2 },
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toBe("export const value = 1;");
    expect(dispatcher.prompts).toHaveLength(3);
  });

  it("retries only the failing step in a multi-step phase, not already-applied steps", async () => {
    // Mirrors a real bedrock-sonnet run: a two-step phase where step 1's
    // patch succeeds and is written to disk immediately, then step 2's
    // patch fails to parse. The retry must target ONLY step 2 -- re-sending
    // step 1's instruction (already satisfied) causes the model to
    // (incorrectly) report "everything is already implemented" instead of
    // fixing step 2.
    const steps: Step[] = [
      { number: 1, title: "Create a.ts", body: "Create src/a.ts exporting a=1" },
      { number: 2, title: "Create b.ts", body: "Create src/b.ts exporting b=2" },
    ];
    const dispatcher = sequenceDispatcher([
      "src/a.ts\n<<<<<<< SEARCH\n=======\nexport const a = 1;\n>>>>>>> REPLACE",
      "Looking at the current file contents, step 1 is already fully implemented.",
      "src/b.ts\n<<<<<<< SEARCH\n=======\nexport const b = 2;\n>>>>>>> REPLACE",
    ]);
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(0)),
      steps,
      retryConfig: { maxLocalRetries: 1, maxEscalationRetries: 0 },
    });

    const result = await step.execute({ event: makeEvent("Add both files"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "src/a.ts"), "utf8")).toBe("export const a = 1;");
    expect(readFileSync(join(workspace, "src/b.ts"), "utf8")).toBe("export const b = 2;");

    // The retry prompt (3rd dispatch call) must target step 2 only -- it
    // should NOT re-send step 1's title/instruction.
    expect(dispatcher.prompts).toHaveLength(3);
    expect(dispatcher.prompts[2]).toContain("Create src/b.ts exporting b=2");
    expect(dispatcher.prompts[2]).not.toContain("Create src/a.ts exporting a=1");
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

describe("buildBaselineContext", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "baseline-context-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const tsConfig = (roots: string[]): DevCycleLanguageConfig => ({
    name: "typescript",
    implementSystem: "sys",
    languageHint: "TypeScript",
    sourceExtensions: [".ts"],
    sourceRoots: roots,
    toolchainSteps: () => [],
  });

  it("returns empty string when no source files exist and no git diff", () => {
    const result = buildBaselineContext(dir, tsConfig(["src"]));
    expect(result).toBe("");
  });

  it("includes file contents for matching extensions", () => {
    const srcDir = join(dir, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "index.ts"), "export const x = 1;");
    const result = buildBaselineContext(dir, tsConfig(["src"]));
    expect(result).toContain("export const x = 1;");
    expect(result).toContain("src/index.ts");
  });

  it("excludes files with non-matching extensions", () => {
    const srcDir = join(dir, "src");
    mkdirSync(srcDir);
    writeFileSync(join(srcDir, "index.ts"), "ts content");
    writeFileSync(join(srcDir, "README.md"), "md content");
    const result = buildBaselineContext(dir, tsConfig(["src"]));
    expect(result).toContain("ts content");
    expect(result).not.toContain("md content");
  });

  it("discovers files recursively into subdirectories", () => {
    const srcDir = join(dir, "src");
    const subDir = join(srcDir, "utils");
    mkdirSync(srcDir);
    mkdirSync(subDir);
    writeFileSync(join(subDir, "helper.ts"), "export const h = 2;");
    const result = buildBaselineContext(dir, tsConfig(["src"]));
    expect(result).toContain("export const h = 2;");
  });

  it("searches all declared sourceRoots", () => {
    const srcDir = join(dir, "src");
    const libDir = join(dir, "lib");
    mkdirSync(srcDir);
    mkdirSync(libDir);
    writeFileSync(join(srcDir, "a.ts"), "const a = 1;");
    writeFileSync(join(libDir, "b.ts"), "const b = 2;");
    const result = buildBaselineContext(dir, tsConfig(["src", "lib"]));
    expect(result).toContain("const a = 1;");
    expect(result).toContain("const b = 2;");
  });

  it("skips node_modules junk directory", () => {
    const nmDir = join(dir, "node_modules", "pkg");
    mkdirSync(nmDir, { recursive: true });
    writeFileSync(join(nmDir, "index.ts"), "should be excluded");
    const result = buildBaselineContext(dir, tsConfig(["."]));
    expect(result).not.toContain("should be excluded");
  });

  it("defaults to workspace root when sourceRoots is undefined", () => {
    writeFileSync(join(dir, "main.ts"), "export const main = true;");
    const config: DevCycleLanguageConfig = {
      name: "typescript",
      implementSystem: "sys",
      languageHint: "TypeScript",
      sourceExtensions: [".ts"],
      toolchainSteps: () => [],
    };
    const result = buildBaselineContext(dir, config);
    expect(result).toContain("export const main = true;");
  });
});
