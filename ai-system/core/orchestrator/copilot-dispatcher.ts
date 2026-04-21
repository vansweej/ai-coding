import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

const COPILOT_CHAT_URL = "https://api.githubcopilot.com/chat/completions";

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
        model: request.model,
        messages,
        stream: false,
      };

      if (request.temperature !== undefined) body.temperature = request.temperature;
      if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
          "User-Agent": "ai-coding-os/1.0.0",
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
