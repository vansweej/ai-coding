import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import type { PipelineStep, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../config/model-profiles";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import type { ToolchainDescriptor } from "./definitions/language-configs";
import {
  BaselineCheckError,
  attributePhaseFailure,
  findImplicatedWholeRepoValidators,
  runPhase,
  runValidatorSteps,
} from "./phase-runner";
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

function config(response: string): OrchestratorConfig {
  return {
    profile: LOCAL_PROFILE,
    dispatchers: { "gemma4:26b": dispatcher(response) },
  };
}

/** A response that always fails to parse as an aider-style patch. */
const MALFORMED_RESPONSE = "I need more context before I can make this change.";

function fakeStep(name: string, ok: boolean): PipelineStep<AIRequestEvent> {
  return {
    name,
    execute: async (): Promise<Result<StepResult>> =>
      ok
        ? { ok: true, value: { stepName: name, output: "ok", durationMs: 0 } }
        : { ok: false, error: new Error(`${name} failed`) },
  };
}

function fakeDescriptor(
  id: ToolchainDescriptor["id"],
  steps: readonly PipelineStep<AIRequestEvent>[],
): ToolchainDescriptor {
  return {
    id,
    languageHint: id,
    markerTools: [],
    driverTools: [],
    idioms: "",
    isWholeRepoValidator: true,
    toolchainSteps: () => steps,
  };
}

const PHASE: Phase = {
  number: 1,
  title: "Core",
  commitMessage: "feat: add core",
  steps: [{ number: 1, title: "Step", body: "Do it" }],
  coverage: { mode: "default" },
};

let workspace: string;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "phase-runner-test-"));
  await $`git init`.cwd(workspace).quiet();
  await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
  await $`git config user.name "Test User"`.cwd(workspace).quiet();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("runPhase", () => {
  it("commits after a successful phase (floor-routed, no verification steps)", async () => {
    const commits: string[] = [];
    const result = await runPhase(PHASE, {
      config: config("src/index.md\n<<<<<<< SEARCH\n=======\n# Hello\n>>>>>>> REPLACE"),
      workspace,
      palette: new Set(),
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

  it("does not commit and returns the original failure when the phase's implementation cannot be parsed", async () => {
    const commits: string[] = [];
    const result = await runPhase(PHASE, {
      config: config(MALFORMED_RESPONSE),
      workspace,
      palette: new Set(),
      retryConfig: { maxLocalRetries: 0, maxEscalationRetries: 0 },
      commitPhase: async (_workspace, message, _phaseNumber) => {
        commits.push(message);
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBeInstanceOf(BaselineCheckError);
    }
    expect(commits).toEqual([]);
  });

  it("threads phaseNumber and onProgress through to the verified-implement step's events", async () => {
    const events: ProgressEvent[] = [];
    const result = await runPhase(PHASE, {
      config: config("src/index.md\n<<<<<<< SEARCH\n=======\n# Hello\n>>>>>>> REPLACE"),
      workspace,
      palette: new Set(),
      onProgress: (e) => events.push(e),
      commitPhase: async (_workspace, message, _phaseNumber) => ({ ok: true, value: message }),
    });

    expect(result.ok).toBe(true);
    expect(events).toEqual([
      { kind: "step-start", phase: 1, step: 1, title: "Step" },
      { kind: "step-finish", phase: 1, step: 1 },
    ]);
  });

  it("returns the original failure unchanged when the touched file's toolchain is not a whole-repo validator", async () => {
    writeFileSync(join(workspace, "a.rs"), "// baseline\n");
    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -q -m baseline`.cwd(workspace).quiet();
    writeFileSync(join(workspace, "a.rs"), "// dirty (this phase's own change)\n");

    const result = await runPhase(PHASE, {
      config: config(MALFORMED_RESPONSE),
      workspace,
      palette: new Set(["cargo"]),
      retryConfig: { maxLocalRetries: 0, maxEscalationRetries: 0 },
      commitPhase: async () => ({ ok: true, value: "" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBeInstanceOf(BaselineCheckError);
    }
    // The dirty file must be untouched by attribution (rust is not a
    // whole-repo validator, so no stash/pop was ever attempted).
    expect(readFileSync(join(workspace, "a.rs"), "utf8")).toBe(
      "// dirty (this phase's own change)\n",
    );
  });

  it("returns the original failure unchanged when nothing has been touched", async () => {
    const result = await runPhase(PHASE, {
      config: config(MALFORMED_RESPONSE),
      workspace,
      palette: new Set(["cargo", "bun", "nix"]),
      retryConfig: { maxLocalRetries: 0, maxEscalationRetries: 0 },
      commitPhase: async () => ({ ok: true, value: "" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toBeInstanceOf(BaselineCheckError);
    }
  });

  it("wraps the failure in BaselineCheckError when a whole-repo validator fails on the clean pre-phase tree, and restores the dirty tree afterward", async () => {
    writeFileSync(join(workspace, "flake.nix"), "{ }\n");
    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -q -m baseline`.cwd(workspace).quiet();
    writeFileSync(join(workspace, "flake.nix"), "{ this-phase-broke-it = true; }\n");

    const result = await runPhase(PHASE, {
      config: config(MALFORMED_RESPONSE),
      workspace,
      // "nix" itself is on PATH in this devShell, but "nixpkgs-fmt" is not --
      // the nix toolchain's format step will fail (ENOENT) on ANY tree state,
      // deterministically exercising "clean tree also fails" without
      // depending on genuine flake-check semantics.
      palette: new Set(["nix"]),
      retryConfig: { maxLocalRetries: 0, maxEscalationRetries: 0 },
      commitPhase: async () => ({ ok: true, value: "" }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(BaselineCheckError);
    }
    // git stash / stash pop must have restored the dirty tree exactly.
    expect(readFileSync(join(workspace, "flake.nix"), "utf8")).toBe(
      "{ this-phase-broke-it = true; }\n",
    );
  });
});

describe("findImplicatedWholeRepoValidators", () => {
  it("returns an empty array when nothing is touched", () => {
    expect(findImplicatedWholeRepoValidators(workspace, new Set(["nix", "shellcheck"]))).toEqual(
      [],
    );
  });

  it("returns an empty array when the touched file's toolchain is not a whole-repo validator", async () => {
    writeFileSync(join(workspace, "a.rs"), "// baseline\n");
    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -q -m baseline`.cwd(workspace).quiet();
    writeFileSync(join(workspace, "a.rs"), "// modified\n");

    expect(findImplicatedWholeRepoValidators(workspace, new Set(["cargo"]))).toEqual([]);
  });

  it("returns the implicated whole-repo validator descriptor", async () => {
    writeFileSync(join(workspace, "flake.nix"), "{ }\n");
    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -q -m baseline`.cwd(workspace).quiet();
    writeFileSync(join(workspace, "flake.nix"), "{ modified = true; }\n");

    const implicated = findImplicatedWholeRepoValidators(workspace, new Set(["nix"]));
    expect(implicated.map((d) => d.id)).toEqual(["nix"]);
  });
});

describe("runValidatorSteps", () => {
  it("succeeds when every step of every descriptor passes", async () => {
    const result = await runValidatorSteps(workspace, [
      fakeDescriptor("nix", [fakeStep("format", true), fakeStep("check", true)]),
    ]);
    expect(result.ok).toBe(true);
  });

  it("fails on the first failing step and does not run subsequent descriptors", async () => {
    const secondDescriptorCalls: string[] = [];
    const result = await runValidatorSteps(workspace, [
      fakeDescriptor("nix", [fakeStep("format", false)]),
      fakeDescriptor("shell", [
        {
          name: "lint",
          execute: async () => {
            secondDescriptorCalls.push("lint");
            return { ok: true, value: { stepName: "lint", output: "ok", durationMs: 0 } };
          },
        },
      ]),
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("format failed");
    }
    expect(secondDescriptorCalls).toEqual([]);
  });
});

describe("attributePhaseFailure", () => {
  const originalFailure: Result<never> = { ok: false, error: new Error("original failure") };

  it("passes through a successful result unchanged", async () => {
    const success: Result<{ phaseNumber: number; stepsCompleted: number; commitMessage: string }> =
      { ok: true, value: { phaseNumber: 1, stepsCompleted: 1, commitMessage: "ok" } };
    const result = await attributePhaseFailure(workspace, new Set(), success);
    expect(result).toBe(success);
  });

  it("returns the original failure when no whole-repo validator is implicated", async () => {
    const result = await attributePhaseFailure(workspace, new Set(), originalFailure);
    expect(result).toBe(originalFailure);
  });
});
