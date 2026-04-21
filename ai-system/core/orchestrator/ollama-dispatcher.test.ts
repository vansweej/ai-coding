import { describe, expect, it } from "bun:test";

import type { DispatchRequest } from "@ai-coding/shared";

import { OllamaDispatcher } from "./ollama-dispatcher";

/** Build a minimal DispatchRequest. */
function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    model: "qwen3:8b",
    prompt: "Write a hello world function",
    ...overrides,
  };
}

/** Create a mock fetch that returns a successful Ollama response. */
function mockFetch(status: number, body: unknown): typeof fetch {
  return Object.assign(async () => new Response(JSON.stringify(body), { status }), {
    preconnect: () => {},
  }) as unknown as typeof fetch;
}

/** Create a mock fetch that rejects (network error). */
function errorFetch(message: string): typeof fetch {
  return Object.assign(
    async () => {
      throw new Error(message);
    },
    { preconnect: () => {} },
  ) as unknown as typeof fetch;
}

describe("OllamaDispatcher", () => {
  it("returns the model response on success", async () => {
    const dispatcher = new OllamaDispatcher("http://localhost:11434");
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(200, { response: "fn hello() {}" });

    try {
      const result = await dispatcher.dispatch(makeRequest());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("fn hello() {}");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns error when Ollama responds with non-2xx status", async () => {
    const dispatcher = new OllamaDispatcher("http://localhost:11434");
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(500, "internal server error");

    try {
      const result = await dispatcher.dispatch(makeRequest());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Ollama returned 500");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns error on network failure", async () => {
    const dispatcher = new OllamaDispatcher("http://localhost:11434");
    const origFetch = globalThis.fetch;
    globalThis.fetch = errorFetch("connection refused");

    try {
      const result = await dispatcher.dispatch(makeRequest());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("connection refused");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("includes system prompt in request body when provided", async () => {
    const dispatcher = new OllamaDispatcher("http://localhost:11434");
    const origFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = Object.assign(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
      },
      { preconnect: () => {} },
    ) as unknown as typeof fetch;

    try {
      await dispatcher.dispatch(makeRequest({ system: "Be concise." }));
      expect(capturedBody.system).toBe("Be concise.");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("forwards temperature and maxTokens as Ollama options", async () => {
    const dispatcher = new OllamaDispatcher("http://localhost:11434");
    const origFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = Object.assign(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
      },
      { preconnect: () => {} },
    ) as unknown as typeof fetch;

    try {
      await dispatcher.dispatch(makeRequest({ temperature: 0.5, maxTokens: 256 }));
      const options = capturedBody.options as Record<string, unknown>;
      expect(options.temperature).toBe(0.5);
      expect(options.num_predict).toBe(256);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
