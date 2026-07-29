import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DispatchRequest } from "@ai-coding/shared";
import { OpenCodeZenDispatcher } from "./opencode-zen-dispatcher";

describe("OpenCodeZenDispatcher", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = (async () => {
      throw new Error("fetch not mocked");
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("constructs with api key, model, and default endpoint", () => {
    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    expect(dispatcher).toBeDefined();
  });

  it("constructs with no api key (free-tier usage)", () => {
    const dispatcher = new OpenCodeZenDispatcher(undefined, "deepseek-v4-flash-free");
    expect(dispatcher).toBeDefined();
  });

  it("dispatches a simple prompt successfully", async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Hello!" } }] }),
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const request: DispatchRequest = {
      model: "opencode-free",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Hello!");
    }
  });

  it("includes system prompt as a message before the user message", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const request: DispatchRequest = {
      model: "opencode-free",
      prompt: "Say hello",
      system: "You are a helpful assistant",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      const body = capturedBody as Record<string, unknown>;
      const messages = body.messages as Array<{ role: string; content: string }>;
      expect(messages.length).toBe(2);
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]?.content).toBe("You are a helpful assistant");
      expect(messages[1]?.role).toBe("user");
      expect(messages[1]?.content).toBe("Say hello");
    }
  });

  it("has only a user message when no system prompt is provided", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const request: DispatchRequest = {
      model: "opencode-free",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      const body = capturedBody as Record<string, unknown>;
      const messages = body.messages as Array<{ role: string; content: string }>;
      expect(messages.length).toBe(1);
      expect(messages[0]?.role).toBe("user");
    }
  });

  it("always sends the constructor model, ignoring request.model", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const request: DispatchRequest = {
      model: "some-other-logical-token",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      const body = capturedBody as Record<string, unknown>;
      expect(body.model).toBe("deepseek-v4-flash-free");
    }
  });

  it("defaults max_tokens to 8192 when not provided", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const request: DispatchRequest = { model: "opencode-free", prompt: "Say hello" };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      const body = capturedBody as Record<string, unknown>;
      expect(body.max_tokens).toBe(8192);
    }
  });

  it("uses provided maxTokens when set", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const request: DispatchRequest = {
      model: "opencode-free",
      prompt: "Say hello",
      maxTokens: 1000,
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      const body = capturedBody as Record<string, unknown>;
      expect(body.max_tokens).toBe(1000);
    }
  });

  it("includes temperature only when provided", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");

    await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });
    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      const body = capturedBody as Record<string, unknown>;
      expect(body.temperature).toBeUndefined();
    }

    await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello", temperature: 0.7 });
    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      const body = capturedBody as Record<string, unknown>;
      expect(body.temperature).toBe(0.7);
    }
  });

  it("sets stream to false", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedBody = JSON.parse(opts.body as string) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      const body = capturedBody as Record<string, unknown>;
      expect(body.stream).toBe(false);
    }
  });

  it("sets Authorization header to Bearer test-key", async () => {
    let capturedHeaders: Record<string, string> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedHeaders = opts.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(capturedHeaders).toBeDefined();
    if (capturedHeaders) {
      const headers = capturedHeaders as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
    }
  });

  it("omits the Authorization header entirely when constructed with no API key (free-tier models require no auth)", async () => {
    let capturedHeaders: Record<string, string> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedHeaders = opts.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher(undefined, "deepseek-v4-flash-free");
    await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(capturedHeaders).toBeDefined();
    if (capturedHeaders) {
      const headers = capturedHeaders as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      expect(headers["Content-Type"]).toBe("application/json");
    }
  });

  it("omits the Authorization header when constructed with an empty-string API key", async () => {
    let capturedHeaders: Record<string, string> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedHeaders = opts.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("", "deepseek-v4-flash-free");
    await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(capturedHeaders).toBeDefined();
    if (capturedHeaders) {
      const headers = capturedHeaders as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    }
  });

  it("uses a custom endpoint when constructed with one", async () => {
    let capturedUrl = "";

    global.fetch = (async (url: unknown) => {
      capturedUrl = url as string;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Response" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const customEndpoint = "https://custom.endpoint/v1/chat/completions";
    const dispatcher = new OpenCodeZenDispatcher(
      "test-key",
      "deepseek-v4-flash-free",
      customEndpoint,
    );
    await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(capturedUrl).toBe(customEndpoint);
  });

  it("returns error when API returns non-ok status", async () => {
    global.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("invalid-key", "deepseek-v4-flash-free");
    const result = await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("401");
    }
  });

  it("returns error when API returns empty choices", async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [] }),
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const result = await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no content");
    }
  });

  it("returns error when message content is undefined", async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: undefined } }] }),
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const result = await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no content");
    }
  });

  it("returns error when fetch throws", async () => {
    global.fetch = (async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const result = await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Network error");
    }
  });

  it("propagates error when JSON parsing fails", async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Invalid JSON");
        },
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const result = await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid JSON");
    }
  });

  it("returns error when fetch rejects with a non-Error value", async () => {
    global.fetch = (async () => {
      throw "plain string error";
    }) as unknown as typeof fetch;

    const dispatcher = new OpenCodeZenDispatcher("test-key", "deepseek-v4-flash-free");
    const result = await dispatcher.dispatch({ model: "opencode-free", prompt: "Say hello" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("plain string error");
    }
  });
});
