import { describe, expect, it } from "bun:test";

import type { DispatchRequest } from "@ai-coding/shared";

import { CopilotDispatcher } from "./copilot-dispatcher";

/** Build a minimal DispatchRequest. */
function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    model: "claude-sonnet",
    prompt: "Write a hello world function",
    ...overrides,
  };
}

/** Create a mock fetch that returns a successful Copilot response. */
function mockFetch(
  status: number,
  body: unknown,
  captureHeaders?: (headers: Record<string, string>) => void,
): typeof fetch {
  return Object.assign(
    async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (captureHeaders && init?.headers) {
        captureHeaders(init.headers as Record<string, string>);
      }
      return new Response(JSON.stringify(body), { status });
    },
    { preconnect: () => {} },
  ) as unknown as typeof fetch;
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

describe("CopilotDispatcher", () => {
  it("returns the model response on success", async () => {
    const dispatcher = new CopilotDispatcher("gho_test", "http://localhost/test");
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(200, {
      choices: [{ message: { content: "fn hello() {}" } }],
    });

    try {
      const result = await dispatcher.dispatch(makeRequest());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("fn hello() {}");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("sends correct Authorization and required headers", async () => {
    const dispatcher = new CopilotDispatcher("gho_mytoken", "http://localhost/test");
    const origFetch = globalThis.fetch;
    let captured: Record<string, string> = {};
    globalThis.fetch = mockFetch(200, { choices: [{ message: { content: "ok" } }] }, (h) => {
      captured = h;
    });

    try {
      await dispatcher.dispatch(makeRequest());
      expect(captured.Authorization).toBe("Bearer gho_mytoken");
      expect(captured["Openai-Intent"]).toBe("conversation-edits");
      expect(captured["x-initiator"]).toBe("user");
      expect(captured["User-Agent"]).toBe("ai-coding-os/1.0.0");
      expect(captured["Content-Type"]).toBe("application/json");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns error when API responds with non-2xx status", async () => {
    const dispatcher = new CopilotDispatcher("gho_test", "http://localhost/test");
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(400, "bad request: Personal Access Tokens are not supported");

    try {
      const result = await dispatcher.dispatch(makeRequest());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Copilot returned 400");
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns error when choices array is empty", async () => {
    const dispatcher = new CopilotDispatcher("gho_test", "http://localhost/test");
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(200, { choices: [] });

    try {
      const result = await dispatcher.dispatch(makeRequest());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("no choices");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("returns error on network failure", async () => {
    const dispatcher = new CopilotDispatcher("gho_test", "http://localhost/test");
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

  it("includes system message when provided", async () => {
    const dispatcher = new CopilotDispatcher("gho_test", "http://localhost/test");
    const origFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = Object.assign(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        });
      },
      { preconnect: () => {} },
    ) as unknown as typeof fetch;

    try {
      await dispatcher.dispatch(makeRequest({ system: "You are an expert." }));
      const messages = capturedBody.messages as Array<{ role: string; content: string }>;
      expect(messages[0]).toEqual({ role: "system", content: "You are an expert." });
      expect(messages[1]).toEqual({ role: "user", content: "Write a hello world function" });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("forwards temperature and maxTokens to the request body", async () => {
    const dispatcher = new CopilotDispatcher("gho_test", "http://localhost/test");
    const origFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = Object.assign(
      async (_url: URL | RequestInfo, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
        });
      },
      { preconnect: () => {} },
    ) as unknown as typeof fetch;

    try {
      await dispatcher.dispatch(makeRequest({ temperature: 0.3, maxTokens: 512 }));
      expect(capturedBody.temperature).toBe(0.3);
      expect(capturedBody.max_tokens).toBe(512);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
