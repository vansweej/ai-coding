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
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          prompt: request.prompt,
          stream: false,
        }),
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
