import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

const ZEN_CHAT_URL = "https://opencode.ai/zen/v1/chat/completions";
const DEFAULT_MAX_TOKENS = 8192;

interface OpenAIChoice {
  readonly message: { readonly content: string };
}

interface OpenAIChatResponse {
  readonly choices: readonly OpenAIChoice[];
}

/**
 * Dispatcher that sends prompts to OpenCode Zen via the OpenAI-compatible
 * chat/completions endpoint.
 *
 * The concrete model (e.g. `deepseek-v4-flash-free`) is a constructor
 * argument resolved from an env var by the caller, so `request.model` (the
 * logical token) is intentionally ignored and `this.model` is always sent.
 * The system prompt is a message (not a top-level field), and the response
 * is read from `choices[0].message.content`.
 *
 * Auth is an optional Bearer API key. OpenCode Zen's free-tier models (e.g.
 * `deepseek-v4-flash-free`, `big-pickle`) accept requests with no
 * `Authorization` header at all (verified empirically: `POST
 * /v1/chat/completions` with `model: "deepseek-v4-flash-free"` and no auth
 * header returns HTTP 200; the same request for a paid model like `kimi-k3`
 * returns HTTP 401 `AuthError: Missing API key`). So `apiKey` is optional here
 * — when omitted, no `Authorization` header is sent, and the Zen server
 * itself decides whether the target model requires one. This keeps the
 * free-tier path usable with zero account/billing setup, while paid models
 * still fail loudly (surfaced via the existing non-ok-response branch below)
 * if used without a key.
 */
export class OpenCodeZenDispatcher implements ModelDispatcher {
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly endpoint: string;

  constructor(apiKey: string | undefined, model: string, endpoint: string = ZEN_CHAT_URL) {
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = endpoint;
  }

  /**
   * Dispatch a prompt to the OpenCode Zen chat/completions endpoint and
   * return the response text.
   *
   * @param request - The prompt and optional system/temperature/maxTokens.
   */
  async dispatch(request: DispatchRequest): Promise<Result<string>> {
    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (request.system !== undefined) messages.push({ role: "system", content: request.system });
      messages.push({ role: "user", content: request.prompt });

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
      };

      if (request.temperature !== undefined) body.temperature = request.temperature;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "ai-coding-os/1.0.0",
      };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: new Error(`OpenCode Zen returned ${response.status}: ${await response.text()}`),
        };
      }

      const data = (await response.json()) as OpenAIChatResponse;
      const content = data.choices[0]?.message.content;

      if (content === undefined) {
        return { ok: false, error: new Error("OpenCode Zen returned no content") };
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
