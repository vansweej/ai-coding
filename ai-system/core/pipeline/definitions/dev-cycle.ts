import { createFileWriterStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";

/** LLM options for implementation steps. */
const IMPLEMENT_LLM_OPTIONS: LLMOptions = {
  system:
    "You are a coding assistant. Output ONLY the implementation code in fenced code blocks. " +
    "Each block must have the format: ```<language> <relative-file-path>. " +
    "Do not include any explanation or prose outside the code blocks.",
  temperature: 0.4,
};

/**
 * Creates the TypeScript dev-cycle pipeline: plan → implement → write-files → test.
 *
 * Steps:
 *   1. plan        - Sends the original request to the planner model for high-level planning.
 *   2. implement   - Sends the plan + original request to the implementer model for code generation.
 *   3. write-files - Parses fenced code blocks from the implement output and writes them to disk.
 *   4. test        - Runs `bun test` in the workspace (nix-aware: wraps in nix develop if
 *                    flake.nix is present).
 *
 * Model routing flows through the orchestrator using semantic roles:
 *   - plan step      → "planner" role
 *   - implement step → "implementer" role
 *
 * @param config    - Orchestrator config mapping model names to dispatchers.
 * @param workspace - Working directory for the write and test steps. Defaults to process.cwd().
 */
export function createDevCyclePipeline(
  config: OrchestratorConfig,
  workspace?: string,
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
        return `Implement the following plan. Output ONLY fenced code blocks with file paths.\n\nPlan:\n${plan}\n\nOriginal request: ${original}`;
      },
      IMPLEMENT_LLM_OPTIONS,
    ),

    createFileWriterStep<AIRequestEvent>("write-files", {
      readFrom: "implement",
      baseDir: workspace ?? process.cwd(),
    }),

    createNixShellStep<AIRequestEvent>("test", ["bun", "test"], { cwd: workspace }),
  ];
}
