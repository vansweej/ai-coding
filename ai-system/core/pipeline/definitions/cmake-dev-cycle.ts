import { createFileWriterStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineContext, PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { SkillBackend } from "@ai-coding/skills";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";
import { createSkillResolverStep } from "../steps/skill-resolver-step";

const DEFAULT_BUILD_DIR = "build";

/** Name of the skill resolver step — used by downstream steps to read skill context. */
const SKILL_STEP_NAME = "resolve-skills";

/** Base system prompt for C++ implementation steps. */
const IMPLEMENT_BASE_SYSTEM =
  "You are a C++ coding assistant. Output ONLY the implementation code in fenced code blocks. " +
  "Each block must have the format: ```<language> <relative-file-path>. " +
  "Use C++20 idioms. Do not include any explanation or prose outside the code blocks.";

/**
 * Build dynamic LLM options for the implement step.
 * When skill content is available in context, it is prepended to the system prompt
 * so the LLM receives domain-specific instructions before the base C++ coding rules.
 */
function buildImplementLlmOptions(ctx: PipelineContext<AIRequestEvent>): LLMOptions {
  const skillContent = ctx.results.get(SKILL_STEP_NAME)?.output ?? "";
  const system = skillContent
    ? `${skillContent}\n\n---\n\n${IMPLEMENT_BASE_SYSTEM}`
    : IMPLEMENT_BASE_SYSTEM;
  return { system, temperature: 0.4 };
}

/**
 * Creates the CMake dev-cycle pipeline:
 * [resolve-skills →] plan → implement → write-files → configure → build → test.
 *
 * Steps:
 *   0. resolve-skills (optional) - Resolves relevant skills and stores merged content
 *                                   in context for downstream steps to use.
 *   1. plan        - High-level planning via the planner model.
 *   2. implement   - Code generation via the implementer model, informed by the plan.
 *                    When skill resolution ran, skill content is prepended to the system prompt.
 *   3. write-files - Parses fenced code blocks from implement output and writes them to disk.
 *   4. configure   - cmake -S . -B <buildDir> (CMake configuration).
 *   5. build       - cmake --build <buildDir> (fails on compilation errors).
 *   6. test        - ctest --test-dir <buildDir> (fails on any failing test).
 *
 * All shell steps are nix-aware: they run inside `nix develop` when flake.nix
 * is detected in the workspace directory.
 *
 * @param config       - Orchestrator config mapping model names to dispatchers.
 * @param workspace    - Path to the C++ project root (must contain CMakeLists.txt).
 * @param buildDir     - Path to the CMake build directory. Defaults to "build" relative to workspace.
 * @param skillBackend - Optional skill backend. When provided, a skill resolver step is inserted
 *                       before the plan step and skill content enriches the implement system prompt.
 */
export function createCMakeDevCyclePipeline(
  config: OrchestratorConfig,
  workspace: string,
  buildDir: string = DEFAULT_BUILD_DIR,
  skillBackend?: SkillBackend,
): readonly PipelineStep<AIRequestEvent>[] {
  const steps: PipelineStep<AIRequestEvent>[] = [];

  if (skillBackend !== undefined) {
    steps.push(createSkillResolverStep(SKILL_STEP_NAME, skillBackend));
  }

  steps.push(
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
      undefined,
      buildImplementLlmOptions,
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
  );

  return steps;
}
