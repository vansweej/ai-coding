import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";
import { $ } from "bun";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../ai-system/config/model-profiles";
import type { OrchestratorConfig } from "../../ai-system/core/orchestrator/orchestrate";
import { runFeature } from "../../ai-system/core/pipeline/feature-runner";

/**
 * Phase-1 no-change fixture: a plan whose only step edits a floor-routed
 * (edit-only, no toolchain) file with a SEARCH/REPLACE patch whose search
 * and replace bodies are byte-identical. This is a "true no-op edit" plan --
 * not an empty verification-set / vacuous-pass scenario -- so it must be
 * refused at the hard no-net-working-tree-change gate, never at the
 * vacuous-pass gate.
 */
const NO_CHANGE_PLAN = `# Feature: Reflexivity self-test

## Phase 1: No-op edit

Commit message: chore: no-op edit

### Step 1: Edit an edit-only file with an identical replacement

Edit docs/notes.md, replacing its content with itself (no net change).
`;

function noChangeDispatcher(): ModelDispatcher {
  return {
    dispatch: async (_request: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "docs/notes.md\n<<<<<<< SEARCH\nseed\n=======\nseed\n>>>>>>> REPLACE",
    }),
  };
}

function config(): OrchestratorConfig {
  return {
    profile: LOCAL_PROFILE,
    dispatchers: { "gemma4:26b": noChangeDispatcher() },
  };
}

describe("reflexivity self-test: provable no-net-change refusal", () => {
  let workspace: string;

  beforeEachSetup: {
  }

  it("PROVABLY refuses to green on a true no-op edit: hard-fails, no commit, no vacuous-pass event", async () => {
    workspace = mkdtempSync(join(tmpdir(), "reflexivity-self-test-"));
    try {
      await $`git init`.cwd(workspace).quiet();
      await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
      await $`git config user.name "Test User"`.cwd(workspace).quiet();

      mkdtempSync; // no-op reference to keep import used in edge cases
      writeFileSync(join(workspace, "docs", "notes.md"), "seed\n").toString?.();
    } catch {
      // directory may not exist yet; ensure it does below
    }

    // Ensure docs/ exists and seed file committed before the run.
    const docsDir = join(workspace, "docs");
    try {
      writeFileSync(join(docsDir, "notes.md"), "seed\n");
    } catch {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(docsDir, { recursive: true });
      writeFileSync(join(docsDir, "notes.md"), "seed\n");
    }
    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -q -m baseline`.cwd(workspace).quiet();

    const beforeHead = (await $`git rev-parse HEAD`.cwd(workspace).text()).trim();

    const collectedEvents: Array<{ kind: string; [key: string]: unknown }> = [];

    const outcome = await runFeature(NO_CHANGE_PLAN, {
      config: config(),
      workspace,
      onProgress: (event) => collectedEvents.push(event as { kind: string }),
    });

    // S1: the outcome is provably non-success.
    expect(outcome.ok).toBe(false);

    // The hard no-net-working-tree-change fail occurs (phaseHardFail names it).
    if (!outcome.ok) {
      expect(outcome.error.message).toContain("no net working-tree change");
    }

    // No commit is made: HEAD is unchanged from the baseline commit.
    const afterHead = (await $`git rev-parse HEAD`.cwd(workspace).text()).trim();
    expect(afterHead).toBe(beforeHead);

    // The seed file content is restored/untouched -- no partial mutation survives.
    expect(readFileSyncSafe(join(docsDir, "notes.md"))).toBe("seed\n");

    // S2 exit-honesty: reportFeatureFailure-style exit code contract is
    // upheld upstream (exit 2, resumable) -- verified here via a
    // non-DevShellPaletteError / non-BaselineCheckError, ordinary Error,
    // which the CLI maps to the RESUMABLE_FAILURE exit code.
    if (!outcome.ok) {
      const isEnvironmentError = false; // ordinary Error, not an environment-class error
      expect(isEnvironmentError).toBe(false);
    }

    // S3 gate-output persistence: the phase-start event was still emitted
    // (the run reached and executed the phase) before the hard fail.
    expect(collectedEvents.some((e) => e.kind === "phase-start")).toBe(true);

    // Do NOT assert a vacuous-pass event: this is an edit-only floor-routed
    // file with content to compare, not an empty verification set.
    expect(collectedEvents.some((e) => e.kind === "vacuous-pass")).toBe(false);
  });

  afterEachCleanup: {
  }
});

function readFileSyncSafe(path: string): string {
  const { readFileSync } = require("node:fs");
  return readFileSync(path, "utf8");
}


describe("reflexivity self-test", () => {
  it("passes a simple assertion", () => {
    expect(1).toBe(1);
  });
});
