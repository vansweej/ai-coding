import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../config/model-profiles";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import { UnverifiedResumeRangeError, runFeature } from "./feature-runner";
import { resetToPhaseCommit } from "./resume";

/**
 * File-local mock dispatcher: always returns a trivial aider-style patch
 * response, since these tests only care about resume-range behavior, not
 * about a specific phase's content.
 */
function createMockDispatcher(response: string): ModelDispatcher {
  return {
    dispatch: async (_request: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: response,
    }),
  };
}

/** File-local mock orchestrator config, mirroring plan-cycle.integration.test.ts's createMockConfig. */
function createMockConfig(dispatcher: ModelDispatcher, strict: boolean): OrchestratorConfig {
  return {
    profile: LOCAL_PROFILE,
    dispatchers: { "gemma4:26b": dispatcher },
    strict,
  };
}

const PLAN = `# Feature: Resume unverified range

## Phase 1: One

Commit message: feat: one

### Step 1: Implement one

Do one.

## Phase 2: Two

Commit message: feat: two

### Step 1: Implement two

Do two.
`;

const PHASE_2_RESPONSE = "docs/index.md\n<<<<<<< SEARCH\n=======\n# value: 2\n>>>>>>> REPLACE";

let workspace: string;

function runGit(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, encoding: "utf8" });
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "resume-unverified-range-test-"));
  runGit(workspace, "init");
  runGit(workspace, 'config user.email "test@example.com"');
  runGit(workspace, 'config user.name "Test User"');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * Seed a commit carrying a `Phase: 1` trailer but NO `Run-Id:` trailer,
 * mimicking a resume target commit whose provenance cannot be verified.
 */
function seedUnverifiedPhaseCommit(): void {
  mkdirSync(join(workspace, "docs"), { recursive: true });
  writeFileSync(join(workspace, "docs", "index.md"), "", "utf8");
  runGit(workspace, "add -A");
  runGit(workspace, 'commit -m "seed unverified phase-1 target" -m "Phase: 1"');
}

describe("resume unverified-range policy", () => {
  it("degrades by default when the resume target lacks a Run-Id trailer", async () => {
    seedUnverifiedPhaseCommit();

    const result = await runFeature(PLAN, {
      config: createMockConfig(createMockDispatcher(PHASE_2_RESPONSE), false),
      workspace,
      runId: "run-resume-unverified-degrade",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.value)).toContain("seed unverified phase-1 target");
  });

  it("hard-fails with UnverifiedResumeRangeError under strict mode", async () => {
    seedUnverifiedPhaseCommit();
    const headBefore = execSync("git rev-parse HEAD", { cwd: workspace, encoding: "utf8" }).trim();

    const result = await runFeature(PLAN, {
      config: createMockConfig(createMockDispatcher(PHASE_2_RESPONSE), true),
      workspace,
      runId: "run-resume-unverified-strict",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(UnverifiedResumeRangeError);
    expect((result.error as Error).message).toContain("seed unverified phase-1 target");

    const headAfter = execSync("git rev-parse HEAD", { cwd: workspace, encoding: "utf8" }).trim();
    expect(headAfter).toBe(headBefore);
  });
});
