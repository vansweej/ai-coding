import { createFileWriterStep } from "@ai-coding/pipeline";
import type { PipelineContext, PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { SkillBackend } from "@ai-coding/skills";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";
import { createSkillResolverStep } from "../steps/skill-resolver-step";
import { TYPESCRIPT_CONFIG } from "./language-configs";
import type { DevCycleLanguageConfig } from "./language-configs";

/** Name of the skill resolver step — used by downstream steps to read skill context. */
const SKILL_STEP_NAME = "resolve-skills";

/**
 * Build dynamic LLM options for the implement step.
 * When skill content is available in context, it is prepended to the system prompt
 * so the LLM receives domain-specific instructions before the base coding rules.
 */
function buildImplementLlmOptions(
  ctx: PipelineContext<AIRequestEvent>,
  languageConfig: DevCycleLanguageConfig,
): LLMOptions {
  const skillContent = ctx.results.get(SKILL_STEP_NAME)?.output ?? "";
  const system = skillContent
    ? `${skillContent}\n\n---\n\n${languageConfig.implementSystem}`
    : languageConfig.implementSystem;
  return { system, temperature: 0.4 };
}

/**
 * Creates a language-specific dev-cycle pipeline: [resolve-skills →] implement → write-files.
 *
 * Steps:
 *   0. resolve-skills (optional) - Resolves relevant skills and stores merged content
 *                                   in context for downstream steps to use.
 *   1. implement   - Sends the step instruction directly to the implementer model.
 *                    When skill resolution ran, skill content is prepended to the system prompt.
 *   2. write-files - Parses fenced code blocks from the implement output and writes them to disk.
 *
 * Model routing flows through the orchestrator using semantic roles:
 *   - implement step → "implementer" role
 *
 * @param config         - Orchestrator config mapping model names to dispatchers.
 * @param workspace      - Working directory for the write step. Defaults to process.cwd().
 * @param languageConfig - Language-specific prompt and toolchain configuration.
 * @param skillBackend   - Optional skill backend. When provided, a skill resolver step is inserted
 *                         before implementation and skill content enriches the implement system prompt.
 */
export function createDevCyclePipeline(
  config: OrchestratorConfig,
  workspace?: string,
  languageConfig: DevCycleLanguageConfig = TYPESCRIPT_CONFIG,
  skillBackend?: SkillBackend,
): readonly PipelineStep<AIRequestEvent>[] {
  const steps: PipelineStep<AIRequestEvent>[] = [];

  if (skillBackend !== undefined) {
    steps.push(createSkillResolverStep(SKILL_STEP_NAME, skillBackend));
  }

  steps.push(
    createOrchestratorStep(
      "implement",
      "edit",
      config,
      (ctx) => {
        const instruction = ctx.event.payload.input ?? "";
        return `Implement this ${languageConfig.languageHint} step. Output ONLY fenced code blocks with file paths.\n\nInstruction:\n${instruction}`;
      },
      undefined,
      (ctx) => buildImplementLlmOptions(ctx, languageConfig),
    ),

    createFileWriterStep<AIRequestEvent>("write-files", {
      readFrom: "implement",
      baseDir: workspace ?? process.cwd(),
    }),
  );

  return steps;
}
