import { isOllamaModelAvailable, isOllamaReachable } from "@ai-coding/embeddings";
import type { Result } from "@ai-coding/pipeline";
import type { ModelDispatcher } from "@ai-coding/shared";

import { DEFAULT_PROFILE_NAME, findProfile } from "../config/model-profiles";
import { AnthropicDispatcher } from "../core/orchestrator/anthropic-dispatcher";
import {
  BedrockDispatcher,
  parseRegionFromBedrockArn,
} from "../core/orchestrator/bedrock-dispatcher";
import { CopilotDispatcher } from "../core/orchestrator/copilot-dispatcher";
import { OllamaDispatcher } from "../core/orchestrator/ollama-dispatcher";
import type { OrchestratorConfig } from "../core/orchestrator/orchestrate";

/** Model IDs that indicate Copilot/cloud models (not local Ollama). */
const COPILOT_MODEL_IDS = new Set(["claude-sonnet-4.6"]);

/** Model IDs that indicate native Anthropic (Claude Messages API) models. */
const ANTHROPIC_MODEL_IDS = new Set(["claude-sonnet-5"]);

/** Model IDs that indicate Claude-on-Amazon-Bedrock models. */
const BEDROCK_MODEL_IDS = new Set(["bedrock-sonnet"]);

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
 * Check if a model ID is a native Anthropic (Claude Messages API) model.
 *
 * @param modelId - The model ID to check.
 * @returns true if the model is an Anthropic model, false otherwise.
 */
function isAnthropicModel(modelId: string): boolean {
  return ANTHROPIC_MODEL_IDS.has(modelId);
}

/**
 * Check if a model ID is a Claude-on-Amazon-Bedrock model.
 *
 * @param modelId - The model ID to check.
 * @returns true if the model is a Bedrock model, false otherwise.
 */
function isBedrockModel(modelId: string): boolean {
  return BEDROCK_MODEL_IDS.has(modelId);
}

/**
 * Build the OrchestratorConfig by wiring dispatchers for every model ID in the selected profile.
 *
 * For Ollama models: runs Ollama reachability + model-availability preflight.
 * For Copilot models: requires GITHUB_COPILOT_TOKEN environment variable.
 * For Anthropic models: requires ANTHROPIC_API_KEY environment variable.
 * For Bedrock models: requires AWS_BEDROCK_INFERENCE_PROFILE_ARN environment
 * variable; AWS credentials are resolved via the AWS SDK's default provider
 * chain (e.g. `aws sso login` + AWS_PROFILE), not read directly here.
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
  const ollamaModelIds = modelIds.filter(
    (id) => !isCopilotModel(id) && !isAnthropicModel(id) && !isBedrockModel(id),
  );
  const copilotModelIds = modelIds.filter((id) => isCopilotModel(id));
  const anthropicModelIds = modelIds.filter((id) => isAnthropicModel(id));
  const bedrockModelIds = modelIds.filter((id) => isBedrockModel(id));

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
          "Copilot models require GITHUB_COPILOT_TOKEN environment variable to be set.",
        ),
      };
    }
  }

  // Check for Anthropic API key if using Anthropic models
  if (anthropicModelIds.length > 0) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        error: new Error(
          "Anthropic models require ANTHROPIC_API_KEY environment variable to be set.",
        ),
      };
    }
  }

  // Check for the Bedrock inference profile ARN if using Bedrock models.
  // AWS credentials themselves are NOT checked here -- they are resolved
  // lazily by the AWS SDK's default provider chain (e.g. an `aws sso login`
  // session via AWS_PROFILE) the first time a dispatch is attempted.
  let bedrockArn: string | undefined;
  if (bedrockModelIds.length > 0) {
    bedrockArn = process.env.AWS_BEDROCK_INFERENCE_PROFILE_ARN;
    if (!bedrockArn) {
      return {
        ok: false,
        error: new Error(
          "Bedrock models require AWS_BEDROCK_INFERENCE_PROFILE_ARN environment variable to be set. " +
            "Run `aws sso login` and export the inference profile ARN before retrying.",
        ),
      };
    }
  }

  // Wire dispatchers
  const ollama = new OllamaDispatcher(ollamaUrl);
  const copilotToken = process.env.GITHUB_COPILOT_TOKEN ?? "";
  const copilot = new CopilotDispatcher(copilotToken);
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const anthropic = new AnthropicDispatcher(anthropicApiKey);

  const dispatchers: Record<string, ModelDispatcher> = {};
  for (const id of ollamaModelIds) dispatchers[id] = ollama;
  for (const id of copilotModelIds) dispatchers[id] = copilot;
  for (const id of anthropicModelIds) dispatchers[id] = anthropic;

  if (bedrockArn !== undefined) {
    const region = parseRegionFromBedrockArn(bedrockArn) ?? process.env.AWS_REGION ?? "us-east-1";
    const bedrock = new BedrockDispatcher(bedrockArn, region);
    for (const id of bedrockModelIds) dispatchers[id] = bedrock;
  }

  return {
    ok: true,
    value: {
      profile,
      dispatchers,
    },
  };
}
