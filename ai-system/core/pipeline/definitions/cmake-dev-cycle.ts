import { createFileWriterStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";

const DEFAULT_BUILD_DIR = "build";

/** LLM options for C++ implementation steps. */
const IMPLEMENT_LLM_OPTIONS: LLMOptions = {
  system:
    "You are a C++ coding assistant. Output ONLY the implementation code in fenced code blocks. " +
    "Each block must have the format: ```<language> <relative-file-path>. " +
    "Use C++20 idioms. Do not include any explanation or prose outside the code blocks.",
  temperature: 0.4,
};

/**
 * Creates the CMake dev-cycle pipeline:
 * plan → implement → write-files → configure → build → test.
 *
 * Steps:
 *   1. plan        - High-level planning via the planner model.
 *   2. implement   - Code generation via the implementer model, informed by the plan.
 *   3. write-files - Parses fenced code blocks from implement output and writes them to disk.
 *   4. configure   - cmake -S . -B <buildDir> (CMake configuration).
 *   5. build       - cmake --build <buildDir> (fails on compilation errors).
 *   6. test        - ctest --test-dir <buildDir> (fails on any failing test).
 *
 * All shell steps are nix-aware: they run inside `nix develop` when flake.nix
 * is detected in the workspace directory.
 *
 * @param config    - Orchestrator config mapping model names to dispatchers.
 * @param workspace - Path to the C++ project root (must contain CMakeLists.txt).
 * @param buildDir  - Path to the CMake build directory. Defaults to "build" relative to workspace.
 */
export function createCMakeDevCyclePipeline(
  config: OrchestratorConfig,
  workspace: string,
  buildDir: string = DEFAULT_BUILD_DIR,
): readonly PipelineStep<AIRequestEvent>[] {
  return [
    createOrchestratorStep("plan", "plan", config),

    createOrchestratorStep(
      "implement",
      "edit",
      config,
      (ctx) => {
        const plan = ctx.results.get("plan")?.output ?? "";
        const original = ctx.event.payload.input ?? "";
        return `Implement the following plan in C++. Output ONLY fenced code blocks with file paths.\n\nPlan:\n${plan}\n\nOriginal request: ${original}`;
      },
      IMPLEMENT_LLM_OPTIONS,
    ),

    createFileWriterStep<AIRequestEvent>("write-files", {
      readFrom: "implement",
      baseDir: workspace,
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
      { cwd: workspace },
    ),
  ];
}
