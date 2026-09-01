import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import { LOCAL_PROFILE } from "../../config/model-profiles";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import { runPhase } from "./phase-runner";
import type { Phase } from "./plan-parser";

function config(): OrchestratorConfig {
  return { profile: LOCAL_PROFILE, dispatchers: {} };
}

function verifyOnlyPhase(assertions?: Phase["assertions"]): Phase {
  return {
    number: 2,
    title: "Verify",
    commitMessage: "feat: verify",
    steps: [],
    coverage: { mode: "default" },
    verifyOnly: true,
    assertions,
  };
}

let workspace: string;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "phase-runner-verify-only-"));
  await $`git init`.cwd(workspace).quiet();
  await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
  await $`git config user.name "Test User"`.cwd(workspace).quiet();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("runPhase verify-only", () => {
  it("returns zero steps and does not commit when assertions pass", async () => {
    writeFileSync(join(workspace, "marker.txt"), "hello world\n");
    let committed = false;

    const result = await runPhase(
      verifyOnlyPhase([{ kind: "contains", path: "marker.txt", needle: "hello world" }]),
      {
        config: config(),
        workspace,
        palette: new Set<string>(),
        commitPhase: async (_workspace, message) => {
          committed = true;
          return { ok: true, value: message };
        },
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.stepsCompleted).toBe(0);
    expect(committed).toBe(false);
  });

  it("succeeds on a clean working tree", async () => {
    writeFileSync(join(workspace, "marker.txt"), "present\n");
    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -m init`.cwd(workspace).quiet();
    let committed = false;

    const result = await runPhase(verifyOnlyPhase([{ kind: "exists", path: "marker.txt" }]), {
      config: config(),
      workspace,
      palette: new Set<string>(),
      commitPhase: async (_workspace, message) => {
        committed = true;
        return { ok: true, value: message };
      },
    });

    expect(result.ok).toBe(true);
    expect(committed).toBe(false);
  });

  it("hard-fails structurally when an assertion is violated", async () => {
    await $`git commit --allow-empty -m init`.cwd(workspace).quiet();

    const result = await runPhase(verifyOnlyPhase([{ kind: "exists", path: "missing.txt" }]), {
      config: config(),
      workspace,
      palette: new Set<string>(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("PhaseHardFailError");
      expect(result.error.message).toContain("structuralAssertion");
    }
  });

  it("hard-fails when assertions are omitted", async () => {
    const result = await runPhase(verifyOnlyPhase(), {
      config: config(),
      workspace,
      palette: new Set<string>(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain("verify-only phase declared no assertions");
  });
});
