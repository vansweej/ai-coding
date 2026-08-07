import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

const COPILOT_CHAT_URL = "https://api.githubcopilot.com/chat/completions";

/**
 * Translate an internal model ID to the Copilot catalog name sent on the wire.
 *
 * Internal IDs may be namespaced with a leading `copilot/` prefix to keep them
 * distinct from same-named models served by other providers (e.g. the internal
 * `copilot/claude-sonnet-5` is Copilot-served, whereas the bare
 * `claude-sonnet-5` is Anthropic-native). Copilot's `/chat/completions`
 * catalog expects the bare name, so the prefix is stripped here. IDs without
 * the prefix pass through unchanged.
 *
 * @param modelId - The internal model ID from the dispatch request.
 * @returns The catalog model name to send as `body.model`.
 */
export function toCopilotWireModel(modelId: string): string {
  const prefix = "copilot/";
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

interface CopilotChoice {
  readonly message: { readonly content: string };
}

interface CopilotChatResponse {
  readonly choices: readonly CopilotChoice[];
}

/** Dispatcher that sends prompts to GitHub Copilot's chat completions API. */
export class CopilotDispatcher implements ModelDispatcher {
  private readonly token: string;
  private readonly endpoint: string;

  constructor(token: string, endpoint: string = COPILOT_CHAT_URL) {
    this.token = token;
    this.endpoint = endpoint;
  }

  async dispatch(request: DispatchRequest): Promise<Result<string>> {
    try {
      type Message = { role: string; content: string };
      const messages: Message[] = [];

      if (request.system !== undefined) {
        messages.push({ role: "system", content: request.system });
      }

      messages.push({ role: "user", content: request.prompt });

      const body: Record<string, unknown> = {
        model: toCopilotWireModel(request.model),
        messages,
        stream: false,
      };

      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;

      // Direct-token passthrough: the durable GITHUB_COPILOT_TOKEN is sent
      // straight to the chat endpoint as the Bearer credential. There is NO
      // copilot_internal/v2/token exchange here — that exchange was observed
      // to be WAF-blocked ("scraping" 403) for opencode-minted OAuth tokens
      // as of the last verification, whereas the durable token authenticates
      // directly (HTTP 200). If this ever changes, re-verify before assuming
      // otherwise. The X-GitHub-Api-Version header is modeled on opencode's
      // own observed behaviour at the time of writing, while keeping
      // ai-coding's own honest User-Agent (no Copilot-Integration-Id or
      // Editor-Version — those belong to the VS Code profile, not opencode's).
      // Copilot-Vision-Request is intentionally omitted: DispatchRequest has no
      // image field, so every request here is text-only.
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "ai-coding-os/1.0.0",
          "X-GitHub-Api-Version": "2026-06-01",
          "Openai-Intent": "conversation-edits",
          "x-initiator": "user",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: new Error(`Copilot returned ${response.status}: ${await response.text()}`),
        };
      }

      const data = (await response.json()) as CopilotChatResponse;
      const content = data.choices[0]?.message.content;

      if (content === undefined) {
        return { ok: false, error: new Error("Copilot returned no choices") };
      }

      return { ok: true, value: content };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
