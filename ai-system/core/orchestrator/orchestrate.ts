import type { AIRequestEvent, AIResponse, ModelDispatcher, Result } from "@ai-coding/shared";

import { resolveMode } from "../mode-router/resolve-mode";
import { selectModel } from "../model-router/select-model";

/** Configuration for the orchestrator, mapping model names to dispatchers. */
export interface OrchestratorConfig {
  readonly dispatchers: Record<string, ModelDispatcher>;
}

/**
 * Orchestrate the full request lifecycle:
 * 1. Resolve operating mode from event source
 * 2. Select the appropriate model
 * 3. Dispatch the prompt to the selected model's backend
 * 4. Return a structured response envelope
 */
export async function orchestrate(
  event: AIRequestEvent,
  config: OrchestratorConfig,
): Promise<Result<AIResponse>> {
  const startedAt = Date.now();

  const mode = resolveMode(event.source);
  const model = selectModel(event, mode);

  const dispatcher = config.dispatchers[model];
  if (!dispatcher) {
    return {
      ok: false,
      error: new Error(`No dispatcher configured for model "${model}"`),
    };
  }

  const prompt = event.payload.input ?? "";
  const result = await dispatcher.dispatch({ model, prompt, context: event.context });

  if (!result.ok) {
    return result;
  }

  const durationMs = Date.now() - startedAt;

  return {
    ok: true,
    value: {
      model,
      mode,
      action: event.action,
      response: result.value,
      timing: { startedAt, durationMs },
    },
  };
}
