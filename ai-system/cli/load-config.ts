import { isOllamaModelAvailable, isOllamaReachable } from "@ai-coding/embeddings";
import type { Result } from "@ai-coding/pipeline";
import type { ModelDispatcher } from "@ai-coding/shared";

import { DEFAULT_PROFILE_NAME, findProfile } from "../config/model-profiles";
import { OllamaDispatcher } from "../core/orchestrator/ollama-dispatcher";
import type { OrchestratorConfig } from "../core/orchestrator/orchestrate";

/**
 * Build the OrchestratorConfig by wiring an Ollama dispatcher for every
 * model ID in the selected profile.
 *
 * An Ollama reachability + model-availability preflight runs before wiring
 * dispatchers.
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

  const reachable = await isOllamaReachable(ollamaUrl);
  if (!reachable) {
    return {
      ok: false,
      error: new Error(
        `Ollama is not reachable at ${ollamaUrl}. Start it with \`ollama serve\` and pull the required model.`,
      ),
    };
  }

  for (const id of modelIds) {
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

  const ollama = new OllamaDispatcher(ollamaUrl);
  const dispatchers: Record<string, ModelDispatcher> = {};
  for (const id of modelIds) dispatchers[id] = ollama;

  return {
    ok: true,
    value: {
      profile,
      dispatchers,
    },
  };
}
