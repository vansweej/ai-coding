import { createFileWriterStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineContext, PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { SkillBackend } from "@ai-coding/skills";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";
import { createSkillResolverStep } from "../steps/skill-resolver-step";

/** Name of the skill resolver step — used by downstream steps to read skill context. */
const SKILL_STEP_NAME = "resolve-skills";

/** Base system prompt for the implement step (language-agnostic). */
const IMPLEMENT_BASE_SYSTEM =
  "You are a coding assistant. Output ONLY the implementation code in fenced code blocks. " +
  "Each block must have the format: ```<language> <relative-file-path>. " +
  "Do not include any explanation or prose outside the code blocks.";

/**
 * Build dynamic LLM options for the implement step.
 * When skill content is available in context, it is prepended to the system prompt
 * so the LLM receives domain-specific instructions before the base coding rules.
 */
function buildImplementLlmOptions(ctx: PipelineContext<AIRequestEvent>): LLMOptions {
  const skillContent = ctx.results.get(SKILL_STEP_NAME)?.output ?? "";
  const system = skillContent
    ? `${skillContent}\n\n---\n\n${IMPLEMENT_BASE_SYSTEM}`
    : IMPLEMENT_BASE_SYSTEM;
  return { system, temperature: 0.4 };
}

/**
 * Creates the TypeScript dev-cycle pipeline: [resolve-skills →] plan → implement → write-files → test.
 *
 * Steps:
 *   0. resolve-skills (optional) - Resolves relevant skills and stores merged content
 *                                   in context for downstream steps to use.
 *   1. plan        - Sends the original request to the planner model for high-level planning.
 *   2. implement   - Sends the plan + original request to the implementer model for code generation.
 *                    When skill resolution ran, skill content is prepended to the system prompt.
 *   3. write-files - Parses fenced code blocks from the implement output and writes them to disk.
 *   4. test        - Runs `bun test` in the workspace (nix-aware: wraps in nix develop if
 *                    flake.nix is present).
 *
 * Model routing flows through the orchestrator using semantic roles:
 *   - plan step      → "planner" role
 *   - implement step → "implementer" role
 *
 * @param config       - Orchestrator config mapping model names to dispatchers.
 * @param workspace    - Working directory for the write and test steps. Defaults to process.cwd().
 * @param skillBackend - Optional skill backend. When provided, a skill resolver step is inserted
 *                       before the plan step and skill content enriches the implement system prompt.
 */
export function createDevCyclePipeline(
  config: OrchestratorConfig,
  workspace?: string,
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
        return `Implement the following plan. Output ONLY fenced code blocks with file paths.\n\nPlan:\n${plan}\n\nOriginal request: ${original}`;
      },
      undefined,
      buildImplementLlmOptions,
    ),

    createFileWriterStep<AIRequestEvent>("write-files", {
      readFrom: "implement",
      baseDir: workspace ?? process.cwd(),
    }),

    createNixShellStep<AIRequestEvent>("test", ["bun", "test"], { cwd: workspace }),
  );

  return steps;
}
