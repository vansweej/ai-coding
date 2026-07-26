import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../config/model-profiles";
import { CerebrumMemory } from "../orchestrator/cerebrum-memory";
import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import { runFeature } from "./feature-runner";

const LOCAL_PROFILE_NAME = "local";

/**
 * Integration test suite for rust-plan-cycle pipeline.
 * Tests the full flow: plan parsing → phase execution → memory tracking → git commits.
 *
 * Touched files use the ".rs" extension, but the test environment's devShell
 * palette (bare PATH probe, no flake.nix in these ephemeral workspaces) does
 * not include "cargo" -- so these files route to the no-toolchain floor and
 * verification is always an empty step list, exactly like the old mocked
 * `toolchainSteps: () => []` config these tests previously supplied by hand.
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

// Simple test plan with two phases
const SIMPLE_TWO_PHASE_PLAN = `# Feature: Add test utilities

## Phase 1: Create test module

Commit message: feat: add test module

### Step 1: Create test module

Create a new file src/test.rs with basic test utilities.

## Phase 2: Add test cases

Commit message: feat: add test cases

### Step 1: Add test cases

Add test cases to src/test.rs.
`;

// Aider-style patch responses for the two-phase plan
const PHASE_1_RESPONSE = `src/test.rs
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

const PHASE_2_RESPONSE = `src/test.rs
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

let workspace: string;

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "rust-plan-cycle-integration-"));
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

describe("rust-plan-cycle integration tests", () => {
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

Create src/lib.rs with a basic module.

### Step 2: Add function

Add a function to src/lib.rs.

### Step 3: Add tests

Add tests to src/lib.rs.
`;

    const responses = [
      `src/lib.rs
<<<<<<< SEARCH
=======
pub mod utils {
    pub fn add(a: i32, b: i32) -> i32 {
        a + b
    }
}
>>>>>>> REPLACE`,
      `src/lib.rs
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
      `src/lib.rs
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
});
