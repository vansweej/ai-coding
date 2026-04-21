import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

interface OllamaGenerateResponse {
  readonly response: string;
}

/** Dispatcher that sends prompts to a local Ollama instance. */
export class OllamaDispatcher implements ModelDispatcher {
  private readonly baseUrl: string;

  constructor(baseUrl: string = DEFAULT_OLLAMA_URL) {
    this.baseUrl = baseUrl;
  }

  async dispatch(request: DispatchRequest): Promise<Result<string>> {
    try {
      const body: Record<string, unknown> = {
        model: request.model,
        prompt: request.prompt,
        stream: false,
      };

      if (request.system !== undefined) {
        body.system = request.system;
      }

      if (request.temperature !== undefined || request.maxTokens !== undefined) {
        const options: Record<string, unknown> = {};
        if (request.temperature !== undefined) options.temperature = request.temperature;
        if (request.maxTokens !== undefined) options.num_predict = request.maxTokens;
        body.options = options;
      }

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: new Error(`Ollama returned ${response.status}: ${await response.text()}`),
        };
      }

      const data = (await response.json()) as OllamaGenerateResponse;
      return { ok: true, value: data.response };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
