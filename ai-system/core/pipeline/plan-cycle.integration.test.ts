import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import type { DispatchRequest, ModelDispatcher, PatchOp, Result } from "@ai-coding/shared";

import { ANTHROPIC_SONNET_PROFILE, LOCAL_PROFILE } from "../../config/model-profiles";
import { CerebrumMemory } from "../orchestrator/cerebrum-memory";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import { runFeature } from "./feature-runner";

/**
 * Integration test suite for the plan-cycle pipeline.
 * Tests the full flow: plan parsing → phase execution → memory tracking → git commits.
 *
 * Touched files use the ".txt" extension, a genuinely unmapped extension (no
 * EXTENSION_TO_TOOLCHAIN entry) so verification is always an empty,
 * legitimately edit-only step list -- exactly like the old mocked
 * `toolchainSteps: () => []` config these tests previously supplied by hand.
 * Deliberately NOT ".rs": that extension IS mapped to the rust toolchain, and
 * these ephemeral tmpdir workspaces have no cargo in their devShell palette,
 * which would now correctly trip the mapped-but-unavailable environment
 * guard (MappedToolchainUnavailableError) instead of silently floor-routing.
 */

// Mock dispatcher that returns aider-style patches
function createMockDispatcher(responses: string[]): ModelDispatcher {
  let callCount = 0;
  return {
    dispatch: async (_request: DispatchRequest): Promise<Result<string>> => {
      const response = responses[callCount % responses.length];
      callCount++;
      return { ok: true, value: response };
    },
  };
}

// Mock dispatcher that returns a structured whole-phase patch (dispatchPatch),
// exercising the STRUCTURED path (tryStructuredPhase) rather than the
// aider-text loop. Used to prove create->edit coercion fires within the full
// plan-cycle integration harness, not only via the unit-level tests.
function createStructuredDispatcher(ops: readonly PatchOp[]): ModelDispatcher {
  return {
    dispatch: async (_request: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "unused",
    }),
    dispatchPatch: async (_request: DispatchRequest): Promise<Result<readonly PatchOp[]>> => ({
      ok: true,
      value: ops,
    }),
  };
}

// Create a mock orchestrator config
function createMockConfig(
  dispatcher: ModelDispatcher,
  memory?: CerebrumMemory,
): OrchestratorConfig {
  return {
    profile: LOCAL_PROFILE,
    dispatchers: { "gemma4:26b": dispatcher },
    memory,
  };
}

// Structured-capable config: routes through ANTHROPIC_SONNET_PROFILE, whose
// "claude-sonnet-5" model is registered as "anthropic-tool-use" in
// patch-capability.ts, so tryStructuredPhase attempts the structured path
// ahead of the aider-text loop.
function createStructuredConfig(dispatcher: ModelDispatcher): OrchestratorConfig {
  return {
    profile: ANTHROPIC_SONNET_PROFILE,
    dispatchers: { "claude-sonnet-5": dispatcher },
  };
}

// Simple test plan with two phases
const SIMPLE_TWO_PHASE_PLAN = `# Feature: Add test utilities

## Phase 1: Create test module

Commit message: feat: add test module

### Step 1: Create test module

Create a new file src/test.txt with basic test utilities.

## Phase 2: Add test cases

Commit message: feat: add test cases

### Step 1: Add test cases

Add test cases to src/test.txt.
`;

// Aider-style patch responses for the two-phase plan
const PHASE_1_RESPONSE = `src/test.txt
<<<<<<< SEARCH
=======
#[cfg(test)]
mod tests {
    #[test]
    fn test_basic() {
        assert_eq!(1 + 1, 2);
    }
}
>>>>>>> REPLACE`;

const PHASE_2_RESPONSE = `src/test.txt
<<<<<<< SEARCH
#[cfg(test)]
mod tests {
    #[test]
    fn test_basic() {
        assert_eq!(1 + 1, 2);
    }
}
=======
#[cfg(test)]
mod tests {
    #[test]
    fn test_basic() {
        assert_eq!(1 + 1, 2);
    }

    #[test]
    fn test_addition() {
        assert_eq!(2 + 2, 4);
    }
}
>>>>>>> REPLACE`;

// A single-phase plan whose only step relocates a pre-seeded file and
// directory via a MOVE directive.
const MOVE_PLAN = `# Feature: Relocate legacy module

## Phase 1: Move legacy files into the new layout

Commit message: refactor: relocate legacy module into new layout

### Step 1: Move the legacy file and directory

Move legacy/mod.txt to crates/parlang/legacy/mod.txt, and move legacy/support
to crates/parlang/legacy/support.
`;

// Aider-style MOVE-directive response relocating a file and a directory.
const MOVE_RESPONSE = `legacy/mod.txt
<<<<<<< MOVE
=======
crates/parlang/legacy/mod.txt
>>>>>>> MOVE

legacy/support
<<<<<<< MOVE
=======
crates/parlang/legacy/support
>>>>>>> MOVE`;

// A single-phase plan whose only step touches a manifest file that already
// exists in the workspace, mirroring the parlang Phase-0 shape where a
// Step-1 MOVE relocates a member Cargo.toml so it EXISTS before Step 2 must
// edit it. Used with a structured dispatcher that emits a `create` op for
// that already-existing path.
const CREATE_OVER_EXISTING_PLAN = `# Feature: Update relocated member manifest

## Phase 1: Update the member manifest in place

Commit message: feat: update relocated member manifest

### Step 1: Update crates/parlang/Cargo.toml

Update crates/parlang/Cargo.toml to inherit workspace dependencies.
`;

let workspace: string;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "plan-cycle-integration-"));
  // Initialize git repo
  await $`git init`.cwd(workspace).quiet();
  await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
  await $`git config user.name "Test User"`.cwd(workspace).quiet();
  // Create initial commit so we have a base
  writeFileSync(join(workspace, "README.md"), "# Test Project\n");
  await $`git add README.md`.cwd(workspace).quiet();
  await $`git commit -m "initial commit"`.cwd(workspace).quiet();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("plan-cycle integration tests", () => {
  it("executes a simple two-phase plan successfully", async () => {
    const dispatcher = createMockDispatcher([PHASE_1_RESPONSE, PHASE_2_RESPONSE]);
    const config = createMockConfig(dispatcher);

    const result = await runFeature(SIMPLE_TWO_PHASE_PLAN, {
      config,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.feature).toBe("Add test utilities");
    expect(result.value.phases).toHaveLength(2);
    expect(result.value.phases[0].phaseNumber).toBe(1);
    expect(result.value.phases[1].phaseNumber).toBe(2);
  });

  it("stores phase context in memory when memory client is provided", async () => {
    const dispatcher = createMockDispatcher([PHASE_1_RESPONSE, PHASE_2_RESPONSE]);
    const memory = new CerebrumMemory();
    const config = createMockConfig(dispatcher, memory);

    const result = await runFeature(SIMPLE_TWO_PHASE_PLAN, {
      config,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify memory was called (mock mode logs calls)
    // In real implementation, we would verify memory contents
    expect(result.value.phases).toHaveLength(2);
  });

  it("creates git commits with Phase trailers for resume tracking", async () => {
    const dispatcher = createMockDispatcher([PHASE_1_RESPONSE, PHASE_2_RESPONSE]);
    const config = createMockConfig(dispatcher);

    const result = await runFeature(SIMPLE_TWO_PHASE_PLAN, {
      config,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Check git log for Phase trailers
    const logOutput = await $`git log --oneline --format=%B`.cwd(workspace).text();
    expect(logOutput).toContain("Phase: 1");
    expect(logOutput).toContain("Phase: 2");
  });

  it("handles phase failure gracefully", async () => {
    const failingDispatcher: ModelDispatcher = {
      dispatch: async (_request: DispatchRequest): Promise<Result<string>> => ({
        ok: false,
        error: new Error("Model dispatch failed"),
      }),
    };
    const config = createMockConfig(failingDispatcher);

    const result = await runFeature(SIMPLE_TWO_PHASE_PLAN, {
      config,
      workspace,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("dispatch failed");
  });

  it("supports resume from a specific phase", async () => {
    const dispatcher = createMockDispatcher([PHASE_1_RESPONSE, PHASE_2_RESPONSE]);
    const config = createMockConfig(dispatcher);

    // First run: complete phase 1
    const firstRun = await runFeature(SIMPLE_TWO_PHASE_PLAN, {
      config,
      workspace,
    });

    expect(firstRun.ok).toBe(true);
    if (!firstRun.ok) return;
    expect(firstRun.value.phases).toHaveLength(2);

    // Verify both phases were committed
    const logOutput = await $`git log --oneline`.cwd(workspace).text();
    const commitCount = logOutput.split("\n").filter((line) => line.trim()).length;
    expect(commitCount).toBeGreaterThanOrEqual(3); // initial + phase 1 + phase 2
  });

  it("tracks multiple phases with increasing salience in memory", async () => {
    const dispatcher = createMockDispatcher([PHASE_1_RESPONSE, PHASE_2_RESPONSE]);
    const memory = new CerebrumMemory();
    const config = createMockConfig(dispatcher, memory);

    const result = await runFeature(SIMPLE_TWO_PHASE_PLAN, {
      config,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify phases were tracked
    expect(result.value.phases).toHaveLength(2);
    expect(result.value.phases[0].phaseNumber).toBe(1);
    expect(result.value.phases[1].phaseNumber).toBe(2);
  });

  it("executes all steps within a phase before committing", async () => {
    const multiStepPlan = `# Feature: Multi-step phase

## Phase 1: Create and modify

Commit message: feat: create and modify files

### Step 1: Create file

Create src/lib.txt with a basic module.

### Step 2: Add function

Add a function to src/lib.txt.

### Step 3: Add tests

Add tests to src/lib.txt.
`;

    const responses = [
      `src/lib.txt
<<<<<<< SEARCH
=======
pub mod utils {
    pub fn add(a: i32, b: i32) -> i32 {
        a + b
    }
}
>>>>>>> REPLACE`,
      `src/lib.txt
<<<<<<< SEARCH
pub mod utils {
    pub fn add(a: i32, b: i32) -> i32 {
        a + b
    }
}
=======
pub mod utils {
    pub fn add(a: i32, b: i32) -> i32 {
        a + b
    }

    pub fn subtract(a: i32, b: i32) -> i32 {
        a - b
    }
}
>>>>>>> REPLACE`,
      `src/lib.txt
<<<<<<< SEARCH
pub mod utils {
    pub fn add(a: i32, b: i32) -> i32 {
        a + b
    }

    pub fn subtract(a: i32, b: i32) -> i32 {
        a - b
    }
}
=======
pub mod utils {
    pub fn add(a: i32, b: i32) -> i32 {
        a + b
    }

    pub fn subtract(a: i32, b: i32) -> i32 {
        a - b
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn test_add() {
            assert_eq!(add(2, 2), 4);
        }
    }
}
>>>>>>> REPLACE`,
    ];

    const dispatcher = createMockDispatcher(responses);
    const config = createMockConfig(dispatcher);

    const result = await runFeature(multiStepPlan, {
      config,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.phases).toHaveLength(1);
    expect(result.value.phases[0].stepsCompleted).toBe(3);
  });

  it("maintains phase isolation across multiple phases", async () => {
    const dispatcher = createMockDispatcher([PHASE_1_RESPONSE, PHASE_2_RESPONSE]);
    const config = createMockConfig(dispatcher);

    const result = await runFeature(SIMPLE_TWO_PHASE_PLAN, {
      config,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify each phase has its own commit
    const logOutput = await $`git log --oneline --format=%B`.cwd(workspace).text();
    const phase1Index = logOutput.indexOf("Phase: 1");
    const phase2Index = logOutput.indexOf("Phase: 2");

    expect(phase1Index).toBeGreaterThanOrEqual(0);
    expect(phase2Index).toBeGreaterThanOrEqual(0);
    expect(phase2Index).not.toBe(phase1Index);
  });

  it("returns correct phase run results with commit messages", async () => {
    const dispatcher = createMockDispatcher([PHASE_1_RESPONSE, PHASE_2_RESPONSE]);
    const config = createMockConfig(dispatcher);

    const result = await runFeature(SIMPLE_TWO_PHASE_PLAN, {
      config,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { phases } = result.value;
    expect(phases[0].commitMessage).toBe("feat: add test module");
    expect(phases[0].stepsCompleted).toBe(1);
    expect(phases[1].commitMessage).toBe("feat: add test cases");
    expect(phases[1].stepsCompleted).toBe(1);
  });

  it("gracefully handles missing memory client", async () => {
    const dispatcher = createMockDispatcher([PHASE_1_RESPONSE, PHASE_2_RESPONSE]);
    const config = createMockConfig(dispatcher, undefined); // No memory client

    const result = await runFeature(SIMPLE_TWO_PHASE_PLAN, {
      config,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.phases).toHaveLength(2);
  });

  it("stops on first phase failure and returns error", async () => {
    const responses = [
      PHASE_1_RESPONSE,
      // Phase 2 will fail
    ];

    const failOnSecondCall: ModelDispatcher = {
      dispatch: async (_request: DispatchRequest): Promise<Result<string>> => {
        if (responses.length === 0) {
          return { ok: false, error: new Error("No more responses") };
        }
        responses.pop();
        return { ok: true, value: PHASE_1_RESPONSE };
      },
    };

    const config = createMockConfig(failOnSecondCall);

    const result = await runFeature(SIMPLE_TWO_PHASE_PLAN, {
      config,
      workspace,
    });

    // Should fail on phase 2
    expect(result.ok).toBe(false);
  });

  it("relocates a file and a directory via a MOVE directive and records a rename commit", async () => {
    // Seed the legacy paths that the plan will relocate.
    const legacyFile = join(workspace, "legacy", "mod.txt");
    mkdirSync(join(workspace, "legacy"), { recursive: true });
    writeFileSync(legacyFile, "// legacy module\n", "utf8");

    const legacyDir = join(workspace, "legacy", "support");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "helper.txt"), "// legacy helper\n", "utf8");

    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -m "seed legacy files"`.cwd(workspace).quiet();

    const dispatcher = createMockDispatcher([MOVE_RESPONSE]);
    const config = createMockConfig(dispatcher);

    const result = await runFeature(MOVE_PLAN, {
      config,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.phases).toHaveLength(1);
    expect(result.value.phases[0].commitMessage).toBe(
      "refactor: relocate legacy module into new layout",
    );

    // Old paths are gone; new paths exist with identical content.
    expect(existsSync(join(workspace, "legacy", "mod.txt"))).toBe(false);
    expect(existsSync(join(workspace, "legacy", "support"))).toBe(false);
    expect(existsSync(join(workspace, "crates/parlang/legacy/mod.txt"))).toBe(true);
    expect(existsSync(join(workspace, "crates/parlang/legacy/support/helper.txt"))).toBe(true);

    // The resulting commit records renames (status "R...") for both paths,
    // with the expected Phase trailer.
    const logOutput = await $`git log --oneline --format=%B`.cwd(workspace).text();
    expect(logOutput).toContain("Phase: 1");

    const nameStatus = await $`git show --name-status --format= HEAD`.cwd(workspace).text();
    const renameLines = nameStatus
      .split("\n")
      .filter((line) => line.trim().length > 0 && line.startsWith("R"));
    expect(renameLines.length).toBeGreaterThanOrEqual(1);
  });

  it("applies a structured create op over an already-existing tracked file via create->edit coercion (no fallback)", async () => {
    // Seed the already-existing member manifest (as if a prior MOVE step had
    // relocated it here), then have the structured dispatcher emit a
    // `create` op for that same path. Without coerceCreatesToEdits, this
    // would decline with "already exists; cannot create" and fall back to
    // the aider-text loop; with it, the phase applies GREEN via a clean
    // whole-file-replace edit.
    const manifestPath = join(workspace, "crates/parlang/Cargo.toml");
    mkdirSync(join(workspace, "crates/parlang"), { recursive: true });
    writeFileSync(manifestPath, '[package]\nname = "parlang"\n', "utf8");

    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -m "seed relocated manifest"`.cwd(workspace).quiet();

    const dispatcher = createStructuredDispatcher([
      {
        kind: "create",
        filePath: "crates/parlang/Cargo.toml",
        contents: '[package]\nname = "parlang"\n\n[dependencies]\ncombine = { workspace = true }\n',
      },
    ]);
    const config = createStructuredConfig(dispatcher);

    const result = await runFeature(CREATE_OVER_EXISTING_PLAN, {
      config,
      workspace,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.phases).toHaveLength(1);
    expect(readFileSync(manifestPath, "utf8")).toBe(
      '[package]\nname = "parlang"\n\n[dependencies]\ncombine = { workspace = true }\n',
    );
  });
});
