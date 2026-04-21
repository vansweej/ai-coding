import type { AIAction, AIRequestEvent, Result } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { orchestrate } from "../../orchestrator/orchestrate";
import type { PipelineContext, PipelineStep, StepResult } from "../pipeline-types";

/**
 * Creates a pipeline step that delegates to the orchestrator for an LLM call.
 * The step overrides the event's action with the given action, and uses
 * buildPrompt (if provided) to construct the prompt from pipeline context.
 * When no buildPrompt is provided, the original event's payload.input is used.
 *
 * Model routing flows through the existing orchestrator chain:
 *   resolveMode(source) → selectModel(event, mode) → dispatcher.dispatch()
 *
 * @param name        - Unique step name, used as the key in PipelineContext.results.
 * @param action      - The AI action this step performs (determines model selection).
 * @param config      - Orchestrator config mapping model names to dispatchers.
 * @param buildPrompt - Optional callback to build the prompt from context.
 */
export function createOrchestratorStep(
  name: string,
  action: AIAction,
  config: OrchestratorConfig,
  buildPrompt?: (ctx: PipelineContext) => string,
): PipelineStep {
  return {
    name,
    execute: async (ctx: PipelineContext): Promise<Result<StepResult>> => {
      const startedAt = Date.now();

      const prompt = buildPrompt !== undefined ? buildPrompt(ctx) : (ctx.event.payload.input ?? "");

      const modifiedEvent: AIRequestEvent = {
        ...ctx.event,
        action,
        payload: { ...ctx.event.payload, input: prompt },
      };

      const result = await orchestrate(modifiedEvent, config);

      if (!result.ok) {
        return result;
      }

      return {
        ok: true,
        value: {
          stepName: name,
          output: result.value.response,
          durationMs: Date.now() - startedAt,
        },
      };
    },
  };
}
