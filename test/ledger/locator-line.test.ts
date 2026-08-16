import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../ai-system/config/model-profiles";
import type { OrchestratorConfig } from "../../ai-system/core/orchestrator/orchestrate";
import { runFeature } from "../../ai-system/core/pipeline/feature-runner";
import { createLedgerWriter } from "../../src/ledger/ledger-writer";
import { mintRunId } from "../../src/run/run-id";

/** The canonical regex from the schema contract doc. */
const LOCATOR_RE = /^CHORAGOS-LEDGER runId=(\S+) path=(.+)$/m;

const ONE_PHASE_PLAN = `# Feature: Locator test

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

describe("CHORAGOS-LEDGER locator line", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "ai-coding-locator-test-"));
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

  it("createLedgerWriter produces a path matching the locator regex shape", () => {
    const runId = mintRunId();
    const result = createLedgerWriter(runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const locatorLine = `CHORAGOS-LEDGER runId=${runId} path=${result.value.path}`;
    const match = LOCATOR_RE.exec(locatorLine);

    expect(match).not.toBeNull();
    if (!match) return;

    const [, capturedRunId, capturedPath] = match;
    expect(capturedRunId).toBe(runId);
    expect(isAbsolute(capturedPath)).toBe(true);
  });

  it("ledger file exists on disk after events are written through runFeature", async () => {
    const runId = mintRunId();
    const ledgerResult = createLedgerWriter(runId);
    expect(ledgerResult.ok).toBe(true);
    if (!ledgerResult.ok) return;

    const ledger = ledgerResult.value;

    await runFeature(ONE_PHASE_PLAN, {
      config: createMockConfig(),
      workspace,
      runId,
      onProgress: (event) => {
        ledger.write({
          schema_version: 1,
          runId,
          ts: new Date().toISOString(),
          kind: event.kind,
          ...("phase" in event && event.phase !== undefined ? { phase: event.phase } : {}),
          ...("step" in event && event.step !== undefined ? { step: event.step } : {}),
        });
      },
    });

    ledger.close();
    expect(existsSync(ledger.path)).toBe(true);
    expect(isAbsolute(ledger.path)).toBe(true);

    // Verify the locator line built from this path satisfies the contract regex
    const locatorLine = `CHORAGOS-LEDGER runId=${runId} path=${ledger.path}`;
    expect(LOCATOR_RE.test(locatorLine)).toBe(true);
  });
});
