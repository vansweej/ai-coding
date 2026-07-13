import { isOllamaModelAvailable, isOllamaReachable } from "@ai-coding/embeddings";
import type { Result } from "@ai-coding/pipeline";
import type { ModelDispatcher } from "@ai-coding/shared";

import { DEFAULT_PROFILE_NAME, findProfile } from "../config/model-profiles";
import { CopilotDispatcher } from "../core/orchestrator/copilot-dispatcher";
import { OllamaDispatcher } from "../core/orchestrator/ollama-dispatcher";
import type { OrchestratorConfig } from "../core/orchestrator/orchestrate";

/** Model IDs that indicate Copilot/cloud models (not local Ollama). */
const COPILOT_MODEL_IDS = new Set(["claude-sonnet-4.6"]);

/**
 * Check if a model ID is a Copilot/cloud model.
 *
 * @param modelId - The model ID to check.
 * @returns true if the model is a Copilot model, false otherwise.
 */
function isCopilotModel(modelId: string): boolean {
  return COPILOT_MODEL_IDS.has(modelId);
}

/**
 * Build the OrchestratorConfig by wiring dispatchers for every model ID in the selected profile.
 *
 * For Ollama models: runs Ollama reachability + model-availability preflight.
 * For Copilot models: requires GITHUB_COPILOT_TOKEN environment variable.
 *
 * @param profileName - Profile name; defaults to DEFAULT_PROFILE_NAME.
 * @param ollamaUrl   - Override base URL for Ollama (for testing / remote).
 */
export async function loadConfig(
  profileName: string = DEFAULT_PROFILE_NAME,
  ollamaUrl: string = process.env.OLLAMA_URL ?? "http://localhost:11434",
): Promise<Result<OrchestratorConfig>> {
  const profile = findProfile(profileName);
  if (profile === undefined) {
    return { ok: false, error: new Error(`Unknown profile "${profileName}"`) };
  }

  const modelIds = [...new Set(Object.values(profile.roles))];
  const ollamaModelIds = modelIds.filter((id) => !isCopilotModel(id));
  const copilotModelIds = modelIds.filter((id) => isCopilotModel(id));

  // Check Ollama reachability and model availability only for Ollama models
  if (ollamaModelIds.length > 0) {
    const reachable = await isOllamaReachable(ollamaUrl);
    if (!reachable) {
      return {
        ok: false,
        error: new Error(
          `Ollama is not reachable at ${ollamaUrl}. Start it with \`ollama serve\` and pull the required model.`,
        ),
      };
    }

    for (const id of ollamaModelIds) {
      const available = await isOllamaModelAvailable(id, ollamaUrl);
      if (!available) {
        return {
          ok: false,
          error: new Error(
            `Ollama model "${id}" is not available. Pull it with \`ollama pull ${id}\`.`,
          ),
        };
      }
    }
  }

  // Check for Copilot token if using Copilot models
  if (copilotModelIds.length > 0) {
    const token = process.env.GITHUB_COPILOT_TOKEN;
    if (!token) {
      return {
        ok: false,
        error: new Error(
          `Copilot models require GITHUB_COPILOT_TOKEN environment variable to be set.`,
        ),
      };
    }
  }

  // Wire dispatchers
  const ollama = new OllamaDispatcher(ollamaUrl);
  const copilotToken = process.env.GITHUB_COPILOT_TOKEN ?? "";
  const copilot = new CopilotDispatcher(copilotToken);

  const dispatchers: Record<string, ModelDispatcher> = {};
  for (const id of ollamaModelIds) dispatchers[id] = ollama;
  for (const id of copilotModelIds) dispatchers[id] = copilot;

  return {
    ok: true,
    value: {
      profile,
      dispatchers,
    },
  };
}
