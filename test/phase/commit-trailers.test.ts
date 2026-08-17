import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../ai-system/config/model-profiles";
import type { OrchestratorConfig } from "../../ai-system/core/orchestrator/orchestrate";
import { runFeature } from "../../ai-system/core/pipeline/feature-runner";

const ONE_PHASE_PLAN = `# Feature: Add greeting

## Phase 1: Create greeting file

Commit message: feat: add greeting

### Step 1: Create greeting file

Create src/hello.txt with a hello() function.
`;

const PATCH_RESPONSE = `src/hello.txt
<<<<<<< SEARCH
=======
pub fn hello() -> &'static str { "hello" }
>>>>>>> REPLACE`;

function createMockDispatcher(): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: PATCH_RESPONSE,
    }),
  };
}

function createMockConfig(): OrchestratorConfig {
  return {
    profile: LOCAL_PROFILE,
    dispatchers: { "gemma4:26b": createMockDispatcher() },
  };
}

describe("commit trailers", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "ai-coding-trailers-test-"));
    await $`git init`.cwd(workspace).quiet();
    await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
    await $`git config user.name "Test"`.cwd(workspace).quiet();
    // Initial commit so the repo is not empty
    writeFileSync(join(workspace, "README.md"), "# test\n");
    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -m "chore: initial"`.cwd(workspace).quiet();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("stamps Phase: N and Run-Id: <runId> trailers on the phase commit", async () => {
    const runId = "run-test-abc123";

    const result = await runFeature(ONE_PHASE_PLAN, {
      config: createMockConfig(),
      workspace,
      runId,
    });

    expect(result.ok).toBe(true);

    const commitMsg = await $`git log -1 --format=%B`.cwd(workspace).quiet().text();

    expect(commitMsg).toContain("feat: add greeting");
    expect(commitMsg).toContain("Phase: 1");
    expect(commitMsg).toContain(`Run-Id: ${runId}`);
  });

  it("commits without Run-Id trailer when runId is not provided", async () => {
    const result = await runFeature(ONE_PHASE_PLAN, {
      config: createMockConfig(),
      workspace,
    });

    expect(result.ok).toBe(true);

    const commitMsg = await $`git log -1 --format=%B`.cwd(workspace).quiet().text();

    expect(commitMsg).toContain("feat: add greeting");
    expect(commitMsg).toContain("Phase: 1");
    expect(commitMsg).not.toContain("Run-Id:");
  });
});
