import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import type { PipelineStep, StepResult } from "@ai-coding/pipeline";
import type {
  AIRequestEvent,
  DispatchRequest,
  ModelDispatcher,
  PatchOp,
  Result,
} from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../../config/model-profiles";
import type { ModelProfile } from "../../../config/model-profiles";
import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "../definitions/language-configs";
import type { Step } from "../plan-parser";
import type { ProgressEvent } from "../progress";
import {
  buildBaselineContext,
  buildPaletteLanguageConfig,
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
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toBe("export const value = 1;");
  });

  it("retries locally with verification diagnostics", async () => {
    const dispatcher = sequenceDispatcher([
      "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 'bad';\n>>>>>>> REPLACE",
      "src/index.ts\n<<<<<<< SEARCH\nexport const value = 'bad';\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
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
      "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 'bad';\n>>>>>>> REPLACE",
      "src/index.ts\n<<<<<<< SEARCH\nexport const value = 'bad';\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
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
      "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 'bad';\n>>>>>>> REPLACE",
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

  it("emits step-start then step-finish in order for a passing multi-step phase", async () => {
    const steps: Step[] = [
      { number: 1, title: "Create a.ts", body: "Create src/a.ts exporting a=1" },
      { number: 2, title: "Create b.ts", body: "Create src/b.ts exporting b=2" },
    ];
    const dispatcher = sequenceDispatcher([
      "src/a.ts\n<<<<<<< SEARCH\n=======\nexport const a = 1;\n>>>>>>> REPLACE",
      "src/b.ts\n<<<<<<< SEARCH\n=======\nexport const b = 2;\n>>>>>>> REPLACE",
    ]);
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const events: ProgressEvent[] = [];
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(0)),
      steps,
      phaseNumber: 3,
      onProgress: (e) => events.push(e),
    });

    const result = await step.execute({ event: makeEvent("Add both files"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(events).toEqual([
      { kind: "patch-path", phase: 3, path: "fell-back-to-text", reason: "not-capable-text-mode" },
      { kind: "step-start", phase: 3, step: 1, title: "Create a.ts" },
      { kind: "step-finish", phase: 3, step: 1 },
      { kind: "step-start", phase: 3, step: 2, title: "Create b.ts" },
      { kind: "step-finish", phase: 3, step: 2 },
    ]);
  });

  it("emits step-fail then step-retry then step-finish when a step's implement fails then succeeds", async () => {
    const steps: Step[] = [
      { number: 1, title: "Create a.ts", body: "Create src/a.ts exporting a=1" },
      { number: 2, title: "Create b.ts", body: "Create src/b.ts exporting b=2" },
    ];
    const dispatcher = sequenceDispatcher([
      "src/a.ts\n<<<<<<< SEARCH\n=======\nexport const a = 1;\n>>>>>>> REPLACE",
      "prose response, no patch here",
      "src/b.ts\n<<<<<<< SEARCH\n=======\nexport const b = 2;\n>>>>>>> REPLACE",
    ]);
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const events: ProgressEvent[] = [];
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(0)),
      steps,
      phaseNumber: 5,
      retryConfig: { maxLocalRetries: 1, maxEscalationRetries: 0 },
      onProgress: (e) => events.push(e),
    });

    const result = await step.execute({ event: makeEvent("Add both files"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(events[0]).toEqual({
      kind: "patch-path",
      phase: 5,
      path: "fell-back-to-text",
      reason: "not-capable-text-mode",
    });
    expect(events[1]).toEqual({ kind: "step-start", phase: 5, step: 1, title: "Create a.ts" });
    expect(events[2]).toEqual({ kind: "step-finish", phase: 5, step: 1 });
    expect(events[3]).toEqual({ kind: "step-start", phase: 5, step: 2, title: "Create b.ts" });
    expect(events[4].kind).toBe("step-fail");
    expect(events[5]).toEqual({
      kind: "step-retry",
      phase: 5,
      step: 2,
      index: 1,
      max: 1,
      retry: "local",
    });
    expect(events[6]).toEqual({ kind: "step-finish", phase: 5, step: 2 });
  });

  it("fails with a descriptive error when neither languageConfig nor palette is provided", async () => {
    const dispatcher = sequenceDispatcher(["unused"]);
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", { config, workspace });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('requires either "languageConfig" or "palette"');
    }
  });

  it("composes the implement system from the devShell palette when palette is provided", async () => {
    const systems: (string | undefined)[] = [];
    const dispatcher: ModelDispatcher = {
      dispatch: async (request: DispatchRequest): Promise<Result<string>> => {
        systems.push(request.system);
        return {
          ok: true,
          value:
            "src/lib.rs\n<<<<<<< SEARCH\n=======\npub fn value() -> i32 { 1 }\n>>>>>>> REPLACE",
        };
      },
    };
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    // workspace is not a git repo, so union verification has no touched
    // files to route and trivially succeeds with zero steps -- this test
    // is only exercising the implement-prompt composition wiring.
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      palette: new Set(["cargo"]),
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(systems[0]).toContain("Rust idioms");
    expect(systems[0]).toContain("aider-style");
    expect(systems[0]).toContain("EDIT-ONLY");
  });

  it("prefers palette over languageConfig when both are supplied", async () => {
    const systems: (string | undefined)[] = [];
    const dispatcher: ModelDispatcher = {
      dispatch: async (request: DispatchRequest): Promise<Result<string>> => {
        systems.push(request.system);
        return {
          ok: true,
          value: "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
        };
      },
    };
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(0)),
      palette: new Set(["bun"]),
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    // The legacy languageConfig's fixed system prompt is "system prompt"
    // (see makeLanguageConfig) -- confirms the palette-composed prompt won,
    // not the legacy fixed one.
    expect(systems[0]).not.toBe("system prompt");
    expect(systems[0]).toContain("named exports");
  });

  it("discovers existing source files via paletteExtensions when palette is provided", async () => {
    writeFileSync(join(workspace, "existing.rs"), "pub fn existing() -> i32 { 0 }");
    const dispatcher = sequenceDispatcher([
      "src/lib.rs\n<<<<<<< SEARCH\n=======\npub fn value() -> i32 { 1 }\n>>>>>>> REPLACE",
    ]);
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      palette: new Set(["cargo"]),
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(dispatcher.prompts[0]).toContain("existing.rs");
    expect(dispatcher.prompts[0]).toContain("pub fn existing()");
  });
});

describe("createVerifiedImplementStep (structured whole-phase dual path)", () => {
  const CLAUDE_SONNET_PROFILE: ModelProfile = {
    name: "anthropic-sonnet",
    roles: {
      planner: "claude-sonnet-5",
      implementer: "claude-sonnet-5",
      debugger: "claude-sonnet-5",
      fixer: "claude-sonnet-5",
      reviewer: "claude-sonnet-5",
      tester: "claude-sonnet-5",
      scaffolder: "claude-sonnet-5",
      explorer: "claude-sonnet-5",
      default: "claude-sonnet-5",
    },
  };

  /** A dispatcher exposing BOTH dispatch (text) and dispatchPatch (structured). */
  function dualPathDispatcher(ops: readonly PatchOp[]): ModelDispatcher & { textCalls: number } {
    const state = { textCalls: 0 };
    return {
      get textCalls() {
        return state.textCalls;
      },
      dispatch: async (_req: DispatchRequest): Promise<Result<string>> => {
        state.textCalls += 1;
        return { ok: true, value: "text-path-should-not-be-used" };
      },
      dispatchPatch: async (_req: DispatchRequest): Promise<Result<readonly PatchOp[]>> => ({
        ok: true,
        value: ops,
      }),
    };
  }

  it("structured-green: applies via structured path and never enters the text loop", async () => {
    const dispatcher = dualPathDispatcher([
      { kind: "create", filePath: "src/index.ts", contents: "export const value = 1;" },
    ]);
    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: { "claude-sonnet-5": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(0)),
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toBe("export const value = 1;");
    expect(dispatcher.textCalls).toBe(0);
  });

  it("structured-red: falls back into the text loop when verification fails after structured apply", async () => {
    const dispatcher: ModelDispatcher & { textCalls: number } = (() => {
      const state = { textCalls: 0 };
      return {
        get textCalls() {
          return state.textCalls;
        },
        dispatch: async (_req: DispatchRequest): Promise<Result<string>> => {
          state.textCalls += 1;
          return {
            ok: true,
            value:
              "src/index.ts\n<<<<<<< SEARCH\nexport const value = 'bad';\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
          };
        },
        dispatchPatch: async (_req: DispatchRequest): Promise<Result<readonly PatchOp[]>> => ({
          ok: true,
          value: [
            { kind: "create", filePath: "src/index.ts", contents: "export const value = 'bad';" },
          ],
        }),
      };
    })();

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: { "claude-sonnet-5": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(1)),
      retryConfig: { maxLocalRetries: 1, maxEscalationRetries: 0 },
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(dispatcher.textCalls).toBe(1);
    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toBe("export const value = 1;");
  });

  it("not-capable: falls back immediately to the text loop, unchanged behavior", async () => {
    const dispatcher = sequenceDispatcher([
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
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toBe("export const value = 1;");
  });

  it("partial-apply: rolls back structured changes and falls back to the text loop", async () => {
    writeFileSync(join(workspace, "existing.ts"), "export const a = 1;");
    const dispatcher = (() => {
      const state = { textCalls: 0 };
      return {
        get textCalls() {
          return state.textCalls;
        },
        dispatch: async (_req: DispatchRequest): Promise<Result<string>> => {
          state.textCalls += 1;
          return {
            ok: true,
            value:
              "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
          };
        },
        dispatchPatch: async (_req: DispatchRequest): Promise<Result<readonly PatchOp[]>> => ({
          ok: true,
          value: [
            // op 1 succeeds via applyPatch (a brand-new file).
            { kind: "create", filePath: "src/index.ts", contents: "export const value = 'x';" },
            // op 2 fails via applyPatch: the anchor does not exist in
            // existing.ts, so the whole structured attempt is rejected --
            // op 1's already-applied create must be rolled back before
            // falling back to the text loop.
            { kind: "edit", filePath: "existing.ts", search: "not-present-anchor", replace: "z" },
          ],
        }),
      };
    })();

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: { "claude-sonnet-5": dispatcher },
    };
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(0)),
      retryConfig: { maxLocalRetries: 1, maxEscalationRetries: 0 },
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(dispatcher.textCalls).toBe(1);
    // The rolled-back create must be gone before the text loop's own create succeeds.
    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toBe("export const value = 1;");
  });

  it("emits a structured-applied patch-path event on the verification-green path", async () => {
    const dispatcher = dualPathDispatcher([
      { kind: "create", filePath: "src/index.ts", contents: "export const value = 1;" },
    ]);
    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: { "claude-sonnet-5": dispatcher },
    };
    const events: ProgressEvent[] = [];
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(0)),
      phaseNumber: 7,
      onProgress: (e) => events.push(e),
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(dispatcher.textCalls).toBe(0);
    expect(events).toContainEqual({
      kind: "patch-path",
      phase: 7,
      path: "structured-applied",
      reason: "structured-applied",
    });
  });

  it("emits a fell-back-to-text patch-path event with not-capable-text-mode when the model is not structured-capable", async () => {
    const dispatcher = sequenceDispatcher([
      "src/index.ts\n<<<<<<< SEARCH\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
    ]);
    const config: OrchestratorConfig = {
      profile: LOCAL_PROFILE,
      dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
    };
    const events: ProgressEvent[] = [];
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(0)),
      phaseNumber: 9,
      onProgress: (e) => events.push(e),
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toBe("export const value = 1;");
    expect(events).toContainEqual({
      kind: "patch-path",
      phase: 9,
      path: "fell-back-to-text",
      reason: "not-capable-text-mode",
    });
  });

  it("emits a fell-back-to-text patch-path event with verification-red-after-structured when structured applies but verification fails", async () => {
    const dispatcher: ModelDispatcher & { textCalls: number } = (() => {
      const state = { textCalls: 0 };
      return {
        get textCalls() {
          return state.textCalls;
        },
        dispatch: async (_req: DispatchRequest): Promise<Result<string>> => {
          state.textCalls += 1;
          return {
            ok: true,
            value:
              "src/index.ts\n<<<<<<< SEARCH\nexport const value = 'bad';\n=======\nexport const value = 1;\n>>>>>>> REPLACE",
          };
        },
        dispatchPatch: async (_req: DispatchRequest): Promise<Result<readonly PatchOp[]>> => ({
          ok: true,
          value: [
            { kind: "create", filePath: "src/index.ts", contents: "export const value = 'bad';" },
          ],
        }),
      };
    })();

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: { "claude-sonnet-5": dispatcher },
    };
    const events: ProgressEvent[] = [];
    const step = createVerifiedImplementStep("verified", {
      config,
      workspace,
      languageConfig: makeLanguageConfig(verificationStep(1)),
      retryConfig: { maxLocalRetries: 1, maxEscalationRetries: 0 },
      phaseNumber: 11,
      onProgress: (e) => events.push(e),
    });

    const result = await step.execute({ event: makeEvent("Add value"), results: new Map() });

    expect(result.ok).toBe(true);
    expect(dispatcher.textCalls).toBe(1);
    expect(events).toContainEqual({
      kind: "patch-path",
      phase: 11,
      path: "fell-back-to-text",
      reason: "verification-red-after-structured",
    });
  });
});

describe("buildPaletteLanguageConfig", () => {
  it("threads coverage and diff through to the routed rust toolchain's tarpaulin/coverage steps (P7)", async () => {
    await $`git init -q`.cwd(workspace).quiet();
    await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
    await $`git config user.name "Test"`.cwd(workspace).quiet();
    writeFileSync(join(workspace, "a.rs"), "// initial\n");
    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -q -m initial`.cwd(workspace).quiet();
    writeFileSync(join(workspace, "a.rs"), "// modified\n");

    const gated = buildPaletteLanguageConfig(
      workspace,
      new Set(["cargo", "cargo-tarpaulin"]),
      { mode: "threshold", percent: 95 },
      "",
    );
    expect(gated.toolchainSteps(workspace).map((s) => s.name)).toEqual(
      expect.arrayContaining(["tarpaulin", "coverage"]),
    );

    const skipped = buildPaletteLanguageConfig(
      workspace,
      new Set(["cargo", "cargo-tarpaulin"]),
      { mode: "skip" },
      "",
    );
    expect(skipped.toolchainSteps(workspace).map((s) => s.name)).not.toContain("tarpaulin");
  });

  it("omits tarpaulin/coverage when gated but cargo-tarpaulin is absent from the palette", async () => {
    await $`git init -q`.cwd(workspace).quiet();
    await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
    await $`git config user.name "Test"`.cwd(workspace).quiet();
    writeFileSync(join(workspace, "a.rs"), "// initial\n");
    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -q -m initial`.cwd(workspace).quiet();
    writeFileSync(join(workspace, "a.rs"), "// modified\n");

    const config = buildPaletteLanguageConfig(
      workspace,
      new Set(["cargo"]),
      { mode: "threshold", percent: 95 },
      "",
    );
    expect(config.toolchainSteps(workspace).map((s) => s.name)).not.toContain("tarpaulin");
    expect(config.toolchainSteps(workspace).map((s) => s.name)).not.toContain("coverage");
  });

  it("defaults to no coverage/diff (undefined) when omitted, matching the legacy default-gated behavior", () => {
    const config = buildPaletteLanguageConfig(workspace, new Set(["cargo", "cargo-tarpaulin"]));
    // No touched files in a non-git workspace -- toolchainSteps returns [],
    // but the call itself must not throw when coverage/diff are omitted.
    expect(config.toolchainSteps(workspace)).toEqual([]);
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
