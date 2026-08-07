import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../config/model-profiles";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import { DevShellPaletteError, runFeature } from "./feature-runner";
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

// Uses .md files (floor-routed regardless of devShell palette) so
// verification is always an empty step list -- these tests exercise
// feature-runner's own sequencing/resume/progress logic, independent of
// which toolchains happen to be on PATH in the test environment.
function config(): OrchestratorConfig {
  let requestCount = 0;
  const dispatcher: ModelDispatcher = {
    dispatch: async (_request: DispatchRequest): Promise<Result<string>> => {
      requestCount++;
      // First request (Phase 1): create the file
      if (requestCount === 1) {
        return {
          ok: true,
          value: "docs/index.md\n<<<<<<< SEARCH\n=======\n# value: 1\n>>>>>>> REPLACE",
        };
      }
      // Second request (Phase 2): modify the existing file
      return {
        ok: true,
        value: "docs/index.md\n<<<<<<< SEARCH\n# value: 1\n=======\n# value: 2\n>>>>>>> REPLACE",
      };
    },
  };
  return {
    profile: LOCAL_PROFILE,
    dispatchers: { "gemma4:26b": dispatcher },
  };
}

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
      onProgress: (e) => events.push(e),
      commitPhase: async (_workspace, message, _phaseNumber) => {
        if (message === "feat: two") return { ok: false, error: new Error("commit failed") };
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(false);
    expect(events).toEqual([
      { kind: "phase-start", phase: 1, title: "One" },
      { kind: "patch-path", phase: 1, path: "fell-back-to-text", reason: "not-capable-text-mode" },
      { kind: "step-start", phase: 1, step: 1, title: "Implement one" },
      { kind: "step-finish", phase: 1, step: 1 },
      { kind: "phase-finish", phase: 1, commitMessage: "feat: one" },
      { kind: "phase-start", phase: 2, title: "Two" },
      { kind: "patch-path", phase: 2, path: "fell-back-to-text", reason: "not-capable-text-mode" },
      { kind: "step-start", phase: 2, step: 1, title: "Implement two" },
      { kind: "step-finish", phase: 2, step: 1 },
      { kind: "phase-fail", phase: 2, reason: "commit failed" },
    ]);
  });

  it("returns a DevShellPaletteError-typed environment failure when the workspace's flake.nix is broken", async () => {
    writeFileSync(join(workspace, "flake.nix"), "{ this is not valid nix");

    const result = await runFeature(PLAN, { config: config(), workspace });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(DevShellPaletteError);
    }
  });
});
