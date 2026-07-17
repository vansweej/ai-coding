import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicTextBlock {
  readonly type: string;
  readonly text: string;
}

interface AnthropicMessageResponse {
  readonly content: readonly AnthropicTextBlock[];
}

/**
 * Dispatcher that sends prompts to Anthropic's native Messages API.
 *
 * Differs from the OpenAI-style Copilot dispatcher in several ways: the
 * system prompt is a top-level `system` field (not a message), `max_tokens`
 * is required by the API, auth uses `x-api-key` plus an `anthropic-version`
 * header, and responses are read from `content[0].text`.
 */
export class AnthropicDispatcher implements ModelDispatcher {
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(apiKey: string, endpoint: string = ANTHROPIC_MESSAGES_URL) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  /**
   * Dispatch a prompt to the Anthropic Messages API and return the response text.
   *
   * @param request - The model, prompt, and optional system/temperature/maxTokens.
   */
  async dispatch(request: DispatchRequest): Promise<Result<string>> {
    try {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
      };

      // Anthropic takes the system prompt as a top-level field, not a message.
      if (request.system !== undefined) body.system = request.system;
      if (request.temperature !== undefined) body.temperature = request.temperature;

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "User-Agent": "ai-coding-os/1.0.0",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: new Error(`Anthropic returned ${response.status}: ${await response.text()}`),
        };
      }

      const data = (await response.json()) as AnthropicMessageResponse;
      const content = data.content[0]?.text;

      if (content === undefined) {
        return { ok: false, error: new Error("Anthropic returned no content") };
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
