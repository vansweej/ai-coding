import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../ai-system/config/model-profiles";
import type { OrchestratorConfig } from "../../ai-system/core/orchestrator/orchestrate";
import { runFeature } from "../../ai-system/core/pipeline/feature-runner";
import type { ProgressEvent } from "../../ai-system/core/pipeline/progress";

const ONE_PHASE_PLAN = `# Feature: Test event flow

## Phase 1: Create file

Commit message: feat: create file

### Step 1: Create file

Create src/hello.rs with a hello function.
`;

const PATCH_RESPONSE = `src/hello.rs
<<<<<<< SEARCH
=======
pub fn hello() {}
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

describe("progress event construction", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "ai-coding-progress-test-"));
    await $`git init`.cwd(workspace).quiet();
    await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
    await $`git config user.name "Test"`.cwd(workspace).quiet();
    writeFileSync(join(workspace, "README.md"), "# test\n");
    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -m "chore: initial"`.cwd(workspace).quiet();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("receives phase-start and phase-finish events even when verbose is false", async () => {
    const events: ProgressEvent[] = [];

    const result = await runFeature(ONE_PHASE_PLAN, {
      config: createMockConfig(),
      workspace,
      onProgress: (e) => events.push(e),
    });

    expect(result.ok).toBe(true);
    expect(events.some((e) => e.kind === "phase-start")).toBe(true);
    expect(events.some((e) => e.kind === "phase-finish")).toBe(true);
  });

  it("verbose formatter receives the same events via the shared onProgress callback", async () => {
    const verboseLines: string[] = [];
    const events: ProgressEvent[] = [];

    const result = await runFeature(ONE_PHASE_PLAN, {
      config: createMockConfig(),
      workspace,
      onProgress: (e) => {
        events.push(e);
        // Simulate what the verbose formatter does: format and collect
        verboseLines.push(e.kind);
      },
    });

    expect(result.ok).toBe(true);
    // Both the event stream and the verbose formatter saw the same events
    expect(verboseLines).toEqual(events.map((e) => e.kind));
    expect(verboseLines.length).toBeGreaterThan(0);
  });
});
