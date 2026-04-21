import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Result } from "@ai-coding/pipeline";

import { CopilotDispatcher } from "../core/orchestrator/copilot-dispatcher";
import { OllamaDispatcher } from "../core/orchestrator/ollama-dispatcher";
import type { OrchestratorConfig } from "../core/orchestrator/orchestrate";

interface CopilotTokenConfig {
  readonly token?: string;
}

/**
 * Resolve the GitHub Copilot bearer token.
 *
 * Resolution order:
 *   1. COPILOT_TOKEN environment variable
 *   2. GITHUB_COPILOT_TOKEN environment variable
 *   3. ~/.config/ai-coding/config.json `{ "token": "..." }`
 */
function resolveCopilotToken(): Result<string> {
  const fromEnv = process.env.COPILOT_TOKEN ?? process.env.GITHUB_COPILOT_TOKEN;
  if (fromEnv) {
    return { ok: true, value: fromEnv };
  }

  const configPath = join(homedir(), ".config", "ai-coding", "config.json");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as CopilotTokenConfig;
      if (parsed.token) {
        return { ok: true, value: parsed.token };
      }
    } catch {
      return {
        ok: false,
        error: new Error(`Failed to parse config file at ${configPath}`),
      };
    }
  }

  return {
    ok: false,
    error: new Error(
      "No Copilot token found. Set COPILOT_TOKEN or GITHUB_COPILOT_TOKEN, " +
        `or add { "token": "..." } to ~/.config/ai-coding/config.json`,
    ),
  };
}

/**
 * Build the OrchestratorConfig by wiring up real dispatchers.
 *
 * Dispatcher configuration:
 *   - claude-sonnet    → CopilotDispatcher (token from env or config file)
 *   - deepseek-coder-v2 → OllamaDispatcher
 *   - qwen2.5-coder:7b → OllamaDispatcher
 *
 * Ollama base URL is read from the OLLAMA_URL environment variable,
 * defaulting to http://localhost:11434.
 */
export function loadConfig(): Result<OrchestratorConfig> {
  const tokenResult = resolveCopilotToken();
  if (!tokenResult.ok) {
    return tokenResult;
  }

  const ollamaUrl = process.env.OLLAMA_URL ?? "http://localhost:11434";
  const copilot = new CopilotDispatcher(tokenResult.value);
  const ollama = new OllamaDispatcher(ollamaUrl);

  return {
    ok: true,
    value: {
      dispatchers: {
        "claude-sonnet": copilot,
        "deepseek-coder-v2": ollama,
        "qwen2.5-coder:7b": ollama,
      },
    },
  };
}
