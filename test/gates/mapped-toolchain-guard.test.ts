import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../ai-system/config/model-profiles";
import type { OrchestratorConfig } from "../../ai-system/core/orchestrator/orchestrate";
import { runPhase } from "../../ai-system/core/pipeline/phase-runner";
import type { Phase } from "../../ai-system/core/pipeline/plan-parser";

/**
 * Regression suite for the mapped-but-unavailable-toolchain guard
 * (`hasMappedButUnavailableTouchedFile` wired into `verifyOrFail` in
 * verified-implement-step.ts). Mirrors the git-repo test style used by
 * test/gates/vacuous-pass-guard.test.ts: a real temporary git repository,
 * a mock dispatcher whose aider-style patch response lands specific files,
 * and an assertion on the resulting `MappedToolchainUnavailableError`.
 */

function dispatcherFor(response: string): ModelDispatcher {
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
    dispatchers: { "gemma4:26b": dispatcherFor(response) },
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
  workspace = mkdtempSync(join(tmpdir(), "mapped-toolchain-guard-test-"));
  await $`git init`.cwd(workspace).quiet();
  await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
  await $`git config user.name "Test User"`.cwd(workspace).quiet();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("mapped-but-unavailable toolchain guard", () => {
  it("fails with MappedToolchainUnavailableError when a .rs file is touched but cargo is not in the palette (core regression)", async () => {
    const result = await runPhase(PHASE, {
      config: config("src/lib.rs\n<<<<<<< SEARCH\n=======\nfn hello() {}\n>>>>>>> REPLACE"),
      workspace,
      palette: new Set(["bun"]),
      commitPhase: async (_workspace, message) => ({ ok: true, value: message }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("MappedToolchainUnavailableError");
    }
  });

  it("fails with MappedToolchainUnavailableError when a mixed batch touches both .rs and .ts files, even though .ts routes to non-empty steps", async () => {
    const response = [
      "src/lib.rs",
      "<<<<<<< SEARCH",
      "=======",
      "fn hello() {}",
      ">>>>>>> REPLACE",
      "",
      "src/index.ts",
      "<<<<<<< SEARCH",
      "=======",
      "export const x = 1;",
      ">>>>>>> REPLACE",
    ].join("\n");

    const result = await runPhase(PHASE, {
      config: config(response),
      workspace,
      palette: new Set(["bun"]),
      commitPhase: async (_workspace, message) => ({ ok: true, value: message }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("MappedToolchainUnavailableError");
    }
  });

  it("does not raise MappedToolchainUnavailableError when only a .md file is touched with an empty palette (genuinely-unmapped floor stays valid edit-only)", async () => {
    const result = await runPhase(PHASE, {
      config: config("docs/readme.md\n<<<<<<< SEARCH\n=======\n# Hello\n>>>>>>> REPLACE"),
      workspace,
      palette: new Set(),
      commitPhase: async (_workspace, message) => ({ ok: true, value: message }),
    });

    if (!result.ok) {
      expect(result.error.name).not.toBe("MappedToolchainUnavailableError");
    }
  });

  it("does not raise MappedToolchainUnavailableError for a routed .ts file when bun is in the palette", async () => {
    const result = await runPhase(PHASE, {
      config: config("src/index.ts\n<<<<<<< SEARCH\n=======\nexport const x = 1;\n>>>>>>> REPLACE"),
      workspace,
      palette: new Set(["bun"]),
      commitPhase: async (_workspace, message) => ({ ok: true, value: message }),
    });

    if (!result.ok) {
      expect(result.error.name).not.toBe("MappedToolchainUnavailableError");
    }
  });
});
