import { createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";

const DEFAULT_BUILD_DIR = "build";

/**
 * Creates the CMake dev-cycle pipeline: plan → implement → configure → build → test.
 *
 * Steps:
 *   1. plan      - High-level planning via claude-sonnet.
 *   2. implement - Code generation via qwen2.5-coder:7b, informed by the plan.
 *   3. configure - cmake -S . -B <buildDir> (CMake configuration).
 *   4. build     - cmake --build <buildDir> (fails on compilation errors).
 *   5. test      - ctest --test-dir <buildDir> (fails on any failing test).
 *
 * All shell steps are nix-aware: they run inside `nix develop` when flake.nix
 * is detected in the workspace directory.
 *
 * @param config    - Orchestrator config mapping model names to dispatchers.
 * @param workspace - Path to the C++ project root (must contain CMakeLists.txt).
 * @param buildDir  - Path to the pre-configured CMake build directory. Defaults to "build"
 *                    relative to workspace.
 */
export function createCMakeDevCyclePipeline(
  config: OrchestratorConfig,
  workspace: string,
  buildDir: string = DEFAULT_BUILD_DIR,
): readonly PipelineStep<AIRequestEvent>[] {
  return [
    createOrchestratorStep("plan", "plan", config),

    createOrchestratorStep("implement", "edit", config, (ctx) => {
      const plan = ctx.results.get("plan")?.output ?? "";
      const original = ctx.event.payload.input ?? "";
      return `Implement the following plan in C++:\n\n${plan}\n\nOriginal request: ${original}`;
    }),

    createNixShellStep<AIRequestEvent>("configure", ["cmake", "-S", ".", "-B", buildDir], {
      cwd: workspace,
    }),

    createNixShellStep<AIRequestEvent>("build", ["cmake", "--build", buildDir], {
      cwd: workspace,
    }),

    createNixShellStep<AIRequestEvent>(
      "test",
      ["ctest", "--test-dir", buildDir, "--output-on-failure"],
      {
        cwd: workspace,
      },
    ),
  ];
}
