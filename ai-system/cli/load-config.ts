import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Result } from "@ai-coding/pipeline";

import { CopilotDispatcher } from "../core/orchestrator/copilot-dispatcher";
import { OllamaDispatcher } from "../core/orchestrator/ollama-dispatcher";
import type { OrchestratorConfig } from "../core/orchestrator/orchestrate";

interface OpenCodeAuth {
  readonly "github-copilot"?: {
    readonly access?: string;
  };
}

/**
 * Resolve the GitHub Copilot OAuth token.
 *
 * Resolution order:
 *   1. COPILOT_TOKEN environment variable
 *   2. GITHUB_COPILOT_TOKEN environment variable
 *   3. OpenCode auth file (~/.local/share/opencode/auth.json)
 *
 * @param openCodeAuthPath - Override the OpenCode auth file path (for testing).
 */
export function resolveCopilotToken(
  openCodeAuthPath: string = join(homedir(), ".local", "share", "opencode", "auth.json"),
): Result<string> {
  const fromEnv = process.env.COPILOT_TOKEN ?? process.env.GITHUB_COPILOT_TOKEN;
  if (fromEnv) {
    return { ok: true, value: fromEnv };
  }

  const opencodePath = openCodeAuthPath;
  if (existsSync(opencodePath)) {
    try {
      const raw = readFileSync(opencodePath, "utf8");
      const parsed = JSON.parse(raw) as OpenCodeAuth;
      const token = parsed["github-copilot"]?.access;
      if (token) {
        return { ok: true, value: token };
      }
    } catch {
      return {
        ok: false,
        error: new Error(`Failed to parse OpenCode auth file at ${opencodePath}`),
      };
    }
    /* v8 ignore stop */
  }

  return {
    ok: false,
    error: new Error(
      "No Copilot token found. Set COPILOT_TOKEN or GITHUB_COPILOT_TOKEN, " +
        "or authenticate via OpenCode (opencode auth login).",
    ),
  };
}

/**
 * Build the OrchestratorConfig by wiring up real dispatchers.
 *
 * Dispatcher configuration:
 *   - claude-sonnet    → CopilotDispatcher (token from env or OpenCode auth file)
 *   - deepseek-coder-v2 → OllamaDispatcher
 *   - qwen3:8b → OllamaDispatcher
 *
 * Ollama base URL is read from the OLLAMA_URL environment variable,
 * defaulting to http://localhost:11434.
 */
/* v8 ignore start */
export function loadConfig(openCodeAuthPath?: string): Result<OrchestratorConfig> {
  const tokenResult = resolveCopilotToken(openCodeAuthPath);
  /* v8 ignore stop */
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
        "claude-sonnet-4.6": copilot,
        "deepseek-coder-v2": ollama,
        "qwen3:8b": ollama,
      },
    },
  };
}
/* v8 ignore stop */
