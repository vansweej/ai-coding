import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { PipelineStep, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../ai-system/config/model-profiles";
import type { OrchestratorConfig } from "../../ai-system/core/orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "../../ai-system/core/pipeline/definitions/language-configs";
import type { ProgressEvent } from "../../ai-system/core/pipeline/progress";
import { createVerifiedImplementStep } from "../../ai-system/core/pipeline/steps/verified-implement-step";

function makeEvent(input: string): AIRequestEvent {
  return {
    id: "test",
    timestamp: Date.now(),
    source: "cli",
    modeHint: "agentic",
    action: "task",
    payload: { input },
  };
}

function makeDispatcher(): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "src/hello.ts\n<<<<<<< SEARCH\n=======\nexport const x = 1;\n>>>>>>> REPLACE",
    }),
  };
}

function makeConfig(): OrchestratorConfig {
  return {
    profile: LOCAL_PROFILE,
    dispatchers: { "gemma4:26b": makeDispatcher() },
  };
}

/** Language config whose toolchainSteps always returns [] (empty — vacuous). */
function makeEmptyVerificationConfig(): DevCycleLanguageConfig {
  return {
    name: "typescript",
    implementSystem: "system prompt",
    languageHint: "TypeScript",
    sourceExtensions: [".ts"],
    sourceRoots: ["src"],
    toolchainSteps: (): readonly PipelineStep<AIRequestEvent>[] => [],
  };
}

/** Language config with a real (passing) verification step. */
function makePassingVerificationConfig(): DevCycleLanguageConfig {
  const step: PipelineStep<AIRequestEvent> = {
    name: "verify",
    execute: async (): Promise<Result<StepResult>> => ({
      ok: true,
      value: { stepName: "verify", output: "ok", durationMs: 0 },
    }),
  };
  return {
    name: "typescript",
    implementSystem: "system prompt",
    languageHint: "TypeScript",
    sourceExtensions: [".ts"],
    sourceRoots: ["src"],
    toolchainSteps: (): readonly PipelineStep<AIRequestEvent>[] => [step],
  };
}

describe("vacuous-pass guard", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "vacuous-pass-test-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("fails loudly when phase mode has an empty verification set", async () => {
    const events: ProgressEvent[] = [];
    const step = createVerifiedImplementStep("verified", {
      config: makeConfig(),
      workspace,
      languageConfig: makeEmptyVerificationConfig(),
      // steps defined = phase mode = guard fires
      steps: [{ number: 1, title: "Create file", body: "Create src/hello.ts" }],
      phaseNumber: 1,
      onProgress: (e) => events.push(e),
    });

    const result = await step.execute({ event: makeEvent("Create file"), results: new Map() });

    // Must hard-fail — not a vacuous ok:true
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("vacuous");

    // Must emit a vacuous-pass progress event
    const vacuousEvent = events.find((e) => e.kind === "vacuous-pass");
    expect(vacuousEvent).toBeDefined();
    if (vacuousEvent?.kind === "vacuous-pass") {
      expect(vacuousEvent.phase).toBe(1);
    }
  });

  it("does NOT trip the guard when verification steps are non-empty", async () => {
    const events: ProgressEvent[] = [];
    const step = createVerifiedImplementStep("verified", {
      config: makeConfig(),
      workspace,
      languageConfig: makePassingVerificationConfig(),
      steps: [{ number: 1, title: "Create file", body: "Create src/hello.ts" }],
      phaseNumber: 1,
      onProgress: (e) => events.push(e),
    });

    const result = await step.execute({ event: makeEvent("Create file"), results: new Map() });

    // Should not emit a vacuous-pass event
    expect(events.find((e) => e.kind === "vacuous-pass")).toBeUndefined();
    // Result may succeed or fail for other reasons, but not vacuous-pass
    if (!result.ok) {
      expect(result.error.message).not.toContain("vacuous");
    }
  });

  it("does NOT trip the guard when steps is undefined (non-phase mode)", async () => {
    const events: ProgressEvent[] = [];
    const step = createVerifiedImplementStep("verified", {
      config: makeConfig(),
      workspace,
      languageConfig: makeEmptyVerificationConfig(),
      // steps NOT defined = non-phase mode = guard must not fire
      phaseNumber: 1,
      onProgress: (e) => events.push(e),
    });

    const result = await step.execute({ event: makeEvent("Create file"), results: new Map() });

    // No vacuous-pass event emitted
    expect(events.find((e) => e.kind === "vacuous-pass")).toBeUndefined();
    // Should not fail due to vacuous-pass
    if (!result.ok) {
      expect(result.error.message).not.toContain("vacuous");
    }
  });

  it("does NOT trip for a floor-routed phase with an empty palette", async () => {
    const events: ProgressEvent[] = [];
    const step = createVerifiedImplementStep("verified", {
      config: makeConfig(),
      workspace,
      palette: new Set(),
      steps: [{ number: 1, title: "Create file", body: "Create docs/hello.md" }],
      phaseNumber: 1,
      onProgress: (event) => events.push(event),
    });

    const result = await step.execute({ event: makeEvent("Create file"), results: new Map() });

    expect(events.find((event) => event.kind === "vacuous-pass")).toBeUndefined();
    if (!result.ok) {
      expect(result.error.message).not.toContain("vacuous");
    }
  });

  // Regression test for the false-positive found dogfooding this exact guard
  // (trustworthy-pipeline-s5b): in PALETTE mode, verification is derived from
  // the LIVE git diff (see `runUnionVerification`). A phase on a genuinely
  // CLEAN starting tree (the normal case -- e.g. right after the previous
  // phase committed) has zero touched files BEFORE any implementation
  // attempt runs. If the guard is evaluated once, up front, from that
  // pre-implementation diff, it hard-fails every such phase before the model
  // ever gets a chance to make its real, routable changes -- an over-eager
  // false positive, not the "nothing landed" case the guard exists to catch.
  it("does NOT trip on a clean starting tree when a real implementation attempt lands routable changes (palette mode)", async () => {
    // Use a REAL git repo (not the plain tmpdir from beforeEach) so
    // `runUnionVerification`'s live `git diff`/`git diff --staged` calls
    // reflect actual on-disk state rather than failing silently.
    const gitWorkspace = mkdtempSync(join(tmpdir(), "vacuous-pass-git-test-"));
    try {
      execSync("git init -q", { cwd: gitWorkspace });
      execSync("git config user.email test@example.com", { cwd: gitWorkspace });
      execSync("git config user.name Test", { cwd: gitWorkspace });
      execSync("git commit --allow-empty -q -m init", { cwd: gitWorkspace });

      const events: ProgressEvent[] = [];
      const dispatcher: ModelDispatcher = {
        dispatch: async (): Promise<Result<string>> => ({
          ok: true,
          value: "src/hello.ts\n<<<<<<< SEARCH\n=======\nexport const hello = 1;\n>>>>>>> REPLACE",
        }),
      };
      const step = createVerifiedImplementStep("verified", {
        config: {
          profile: LOCAL_PROFILE,
          dispatchers: { "gemma4:26b": dispatcher, "claude-sonnet-4.6": dispatcher },
        },
        workspace: gitWorkspace,
        palette: new Set(["bun"]),
        // steps defined = phase mode = guard is active
        steps: [{ number: 1, title: "Add hello", body: "Create src/hello.ts" }],
        phaseNumber: 1,
        onProgress: (e) => events.push(e),
      });

      const result = await step.execute({
        event: makeEvent("Add hello"),
        results: new Map(),
      });

      // The guard must NOT have fired: real routable changes landed, so
      // verification proceeds against the ACTUAL typescript toolchain
      // (typecheck/lint/test) rather than short-circuiting on an empty set.
      // The temp workspace has no real package.json/devShell, so the
      // toolchain commands themselves may still fail -- that's fine, this
      // test only asserts the guard did not trip, not that a bare-bones
      // scratch repo satisfies a full TypeScript toolchain.
      expect(events.find((e) => e.kind === "vacuous-pass")).toBeUndefined();
      if (!result.ok) {
        expect(result.error.message).not.toContain("vacuous");
      }
    } finally {
      rmSync(gitWorkspace, { recursive: true, force: true });
    }
  });
});
