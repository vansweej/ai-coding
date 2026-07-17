import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DispatchRequest } from "@ai-coding/shared";
import { AnthropicDispatcher } from "./anthropic-dispatcher";

describe("AnthropicDispatcher", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset fetch to throw by default
    global.fetch = (async () => {
      throw new Error("fetch not mocked");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("constructs with api key and default endpoint", () => {
    const dispatcher = new AnthropicDispatcher("test-key");
    expect(dispatcher).toBeDefined();
  });

  it("constructs with api key and custom endpoint", () => {
    const dispatcher = new AnthropicDispatcher("test-key", "https://custom.endpoint/messages");
    expect(dispatcher).toBeDefined();
  });

  it("dispatches a simple prompt successfully", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "Hello, world!" }],
      }),
    };
    global.fetch = (async () => mockResponse as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Hello, world!");
    }
  });

  it("includes system prompt as a top-level field, not a message", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      const parsed: unknown = JSON.parse(opts.body as string);
      capturedBody = parsed as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "Response" }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
      system: "You are a helpful assistant",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      const body = capturedBody as Record<string, unknown>;
      expect(body.system).toBe("You are a helpful assistant");
      const messages = body.messages as Array<{ role: string; content: string }>;
      expect(messages.length).toBe(1);
      expect(messages[0]?.role).toBe("user");
      expect(messages[0]?.content).toBe("Say hello");
    }
  });

  it("defaults max_tokens to 4096 when not provided", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      const parsed: unknown = JSON.parse(opts.body as string);
      capturedBody = parsed as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "Response" }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      expect((capturedBody as Record<string, unknown>).max_tokens).toBe(4096);
    }
  });

  it("uses provided maxTokens when set", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      const parsed: unknown = JSON.parse(opts.body as string);
      capturedBody = parsed as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "Response" }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
      maxTokens: 1000,
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      expect((capturedBody as Record<string, unknown>).max_tokens).toBe(1000);
    }
  });

  it("includes temperature when provided", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      const parsed: unknown = JSON.parse(opts.body as string);
      capturedBody = parsed as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "Response" }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
      temperature: 0.7,
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      expect((capturedBody as Record<string, unknown>).temperature).toBe(0.7);
    }
  });

  it("sets x-api-key and anthropic-version headers", async () => {
    let capturedHeaders: Record<string, string> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedHeaders = opts.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "Response" }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("my-secret-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedHeaders).toBeDefined();
    if (capturedHeaders) {
      const headers = capturedHeaders as Record<string, string>;
      expect(headers["x-api-key"]).toBe("my-secret-key");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Content-Type"]).toBe("application/json");
    }
  });

  it("passes model ID to API", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      const parsed: unknown = JSON.parse(opts.body as string);
      capturedBody = parsed as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "Response" }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      expect((capturedBody as Record<string, unknown>).model).toBe("claude-sonnet-5");
    }
  });

  it("uses custom endpoint when provided", async () => {
    let capturedUrl = "";

    global.fetch = (async (url: unknown) => {
      capturedUrl = url as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "Response" }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const customEndpoint = "https://custom.endpoint/v1/messages";
    const dispatcher = new AnthropicDispatcher("test-key", customEndpoint);
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedUrl).toBe(customEndpoint);
  });

  it("sets stream to false", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      const parsed = JSON.parse(opts.body as string);
      capturedBody = parsed as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: "Response" }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      expect((capturedBody as Record<string, unknown>).stream).toBe(false);
    }
  });

  it("returns error when API returns non-ok status", async () => {
    global.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("invalid-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("401");
    }
  });

  it("returns error when API returns no content", async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ content: [] }),
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no content");
    }
  });

  it("returns error when API response has no text", async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "text", text: undefined }],
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no content");
    }
  });

  it("returns error when fetch throws", async () => {
    global.fetch = (async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Network error");
    }
  });

  it("returns error when JSON parsing fails", async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Invalid JSON");
        },
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid JSON");
    }
  });

  it("returns error when fetch rejects with a non-Error value", async () => {
    global.fetch = (async () => {
      throw "plain string error";
    }) as unknown as typeof fetch;

    const dispatcher = new AnthropicDispatcher("test-key");
    const request: DispatchRequest = {
      model: "claude-sonnet-5",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("plain string error");
    }
  });
});
