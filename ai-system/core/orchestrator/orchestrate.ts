import type {
  AIRequestEvent,
  AIResponse,
  DispatchRequest,
  ModelDispatcher,
  Result,
} from "@ai-coding/shared";

import type { ModelProfile } from "../../config/model-profiles";
import { resolveModelForRole } from "../../config/model-profiles";
import { resolveMode } from "../mode-router/resolve-mode";
import { actionToRole } from "../model-router/action-to-role";
import { selectModel } from "../model-router/select-model";

/** Configuration for the orchestrator, mapping model names to dispatchers. */
export interface OrchestratorConfig {
  readonly dispatchers: Record<string, ModelDispatcher>;
  /**
   * When set, model selection uses role-based profile routing instead of the
   * legacy action+mode heuristic. All dispatchers required by the profile must
   * be present in the `dispatchers` map.
   */
  readonly profile?: ModelProfile;
}

/** Optional LLM-level parameters forwarded to the dispatcher. */
export interface LLMOptions {
  /** System prompt prepended before the user message. */
  readonly system?: string;
  /** Sampling temperature (0.0–1.0). Provider default is used when omitted. */
  readonly temperature?: number;
  /** Maximum number of tokens to generate. Provider default is used when omitted. */
  readonly maxTokens?: number;
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
  llmOptions?: LLMOptions,
): Promise<Result<AIResponse>> {
  const startedAt = Date.now();

  const mode = resolveMode(event.source);
  const model = config.profile
    ? resolveModelForRole(actionToRole(event.action), config.profile)
    : selectModel(event, mode);

  const dispatcher = config.dispatchers[model];
  if (!dispatcher) {
    return {
      ok: false,
      error: new Error(`No dispatcher configured for model "${model}"`),
    };
  }

  const prompt = event.payload.input ?? "";
  const dispatchRequest: DispatchRequest = {
    model,
    prompt,
    system: llmOptions?.system,
    temperature: llmOptions?.temperature,
    maxTokens: llmOptions?.maxTokens,
    context: event.context,
  };
  const result = await dispatcher.dispatch(dispatchRequest);

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
