import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../config/model-profiles";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import { runFeature } from "./feature-runner";

/**
 * Regression guard for the `Phase:` / `Run-Id:` commit-trailer invariant
 * across a multi-phase `runFeature` run: every phase commit must carry both
 * trailers, and every `Run-Id` value must be identical across the run
 * (stamped once per `runFeature` invocation, never re-minted per phase).
 *
 * File-local mock config/dispatcher helpers -- NOT imported from
 * plan-cycle.integration.test.ts, which does not export them.
 */

const PLAN = `# Feature: Commit trailer invariant

## Phase 1: Create alpha

Commit message: feat: create alpha

### Step 1: Create alpha.txt

Create alpha.txt with some content.

## Phase 2: Create beta

Commit message: feat: create beta

### Step 1: Create beta.txt

Create beta.txt with some content.
`;

// Distinct per-phase responses (queue precedent from MOVE_RESPONSE tests):
// phase 1 creates alpha.txt, phase 2 creates beta.txt -- avoids the
// no-net-change trap where two phases produce identical diffs.
const PHASE_1_RESPONSE = "alpha.txt\n<<<<<<< SEARCH\n=======\n# alpha\n>>>>>>> REPLACE";
const PHASE_2_RESPONSE = "beta.txt\n<<<<<<< SEARCH\n=======\n# beta\n>>>>>>> REPLACE";

function createMockDispatcher(responses: readonly string[]): ModelDispatcher {
  let index = 0;
  return {
    dispatch: async (_request: DispatchRequest): Promise<Result<string>> => {
      const response = responses[index % responses.length];
      index++;
      return { ok: true, value: response };
    },
  };
}

function createMockConfig(dispatcher: ModelDispatcher): OrchestratorConfig {
  return {
    profile: LOCAL_PROFILE,
    dispatchers: { "gemma4:26b": dispatcher },
  };
}

let workspace: string;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "commit-trailer-invariant-"));
  await $`git init`.cwd(workspace).quiet();
  await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
  await $`git config user.name "Test User"`.cwd(workspace).quiet();
  writeFileSync(join(workspace, "README.md"), "# Test Project\n");
  await $`git add README.md`.cwd(workspace).quiet();
  await $`git commit -m "initial commit"`.cwd(workspace).quiet();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("commit-trailer invariant across a multi-phase run", () => {
  it("every phase commit carries both Phase: and Run-Id: trailers", async () => {
    const preRunHead = (await $`git rev-parse HEAD`.cwd(workspace).quiet().text()).trim();

    const dispatcher = createMockDispatcher([PHASE_1_RESPONSE, PHASE_2_RESPONSE]);
    const config = createMockConfig(dispatcher);

    const result = await runFeature(PLAN, {
      config,
      workspace,
      runId: "run-invariant-fixture",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const commitList = (
      await $`git log --format=%H ${preRunHead}..HEAD`.cwd(workspace).quiet().text()
    )
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);

    expect(commitList.length).toBeGreaterThanOrEqual(2);

    for (const sha of commitList) {
      const body = await $`git log -1 --format=%B ${sha}`.cwd(workspace).quiet().text();
      expect(body).toMatch(/Phase:\s*\d+/);
      expect(body).toMatch(/Run-Id:\s*run-invariant-fixture/);
    }
  });

  it("all Run-Id values across phase commits are identical", async () => {
    const preRunHead = (await $`git rev-parse HEAD`.cwd(workspace).quiet().text()).trim();

    const dispatcher = createMockDispatcher([PHASE_1_RESPONSE, PHASE_2_RESPONSE]);
    const config = createMockConfig(dispatcher);

    const result = await runFeature(PLAN, {
      config,
      workspace,
      runId: "run-invariant-fixture",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const commitList = (
      await $`git log --format=%H ${preRunHead}..HEAD`.cwd(workspace).quiet().text()
    )
      .trim()
      .split("\n")
      .filter((line) => line.trim().length > 0);

    expect(commitList.length).toBeGreaterThanOrEqual(2);

    const runIds: string[] = [];
    for (const sha of commitList) {
      const body = await $`git log -1 --format=%B ${sha}`.cwd(workspace).quiet().text();
      const match = /Run-Id:\s*(\S+)/.exec(body);
      if (match) runIds.push(match[1]);
    }

    expect(runIds.length).toBeGreaterThanOrEqual(2);
    expect(new Set(runIds).size).toBe(1);
  });
});
