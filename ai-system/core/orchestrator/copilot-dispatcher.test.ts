import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DispatchRequest } from "@ai-coding/shared";
import { CopilotDispatcher, toCopilotWireModel } from "./copilot-dispatcher";

describe("CopilotDispatcher", () => {
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

  it("constructs with token and default endpoint", () => {
    const dispatcher = new CopilotDispatcher("test-token");
    expect(dispatcher).toBeDefined();
  });

  it("constructs with token and custom endpoint", () => {
    const dispatcher = new CopilotDispatcher("test-token", "https://custom.endpoint/chat");
    expect(dispatcher).toBeDefined();
  });

  it("dispatches a simple prompt successfully", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "Hello, world!" } }],
      }),
    };
    global.fetch = (async () => mockResponse as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Hello, world!");
    }
  });

  it("includes system message when provided", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      const parsed: unknown = JSON.parse(opts.body as string);
      capturedBody = parsed as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
      system: "You are a helpful assistant",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      const messages = (capturedBody as Record<string, unknown>).messages as Array<{
        role: string;
        content: string;
      }>;
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]?.content).toBe("You are a helpful assistant");
      expect(messages[1]?.role).toBe("user");
      expect(messages[1]?.content).toBe("Say hello");
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
          choices: [{ message: { content: "Response" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
      temperature: 0.7,
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      expect((capturedBody as Record<string, unknown>).temperature).toBe(0.7);
    }
  });

  it("includes maxTokens when provided", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      const parsed: unknown = JSON.parse(opts.body as string);
      capturedBody = parsed as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
      maxTokens: 1000,
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      expect((capturedBody as Record<string, unknown>).max_tokens).toBe(1000);
    }
  });

  it("sets Authorization header with Bearer token", async () => {
    let capturedHeaders: Record<string, string> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      const headers: unknown = opts.headers;
      capturedHeaders = headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("my-secret-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedHeaders).toBeDefined();
    if (capturedHeaders) {
      expect((capturedHeaders as Record<string, string>).Authorization).toBe(
        "Bearer my-secret-token",
      );
    }
  });

  it("sets required headers", async () => {
    let capturedHeaders: Record<string, string> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedHeaders = opts.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedHeaders).toBeDefined();
    if (capturedHeaders) {
      expect((capturedHeaders as Record<string, unknown>)["Content-Type"]).toBe("application/json");
      expect((capturedHeaders as Record<string, unknown>)["User-Agent"]).toBe("ai-coding-os/1.0.0");
      expect((capturedHeaders as Record<string, unknown>)["X-GitHub-Api-Version"]).toBe(
        "2026-06-01",
      );
      expect((capturedHeaders as Record<string, unknown>)["Openai-Intent"]).toBe(
        "conversation-edits",
      );
      expect((capturedHeaders as Record<string, unknown>)["x-initiator"]).toBe("user");
    }
  });

  it("sends the X-GitHub-Api-Version header on chat requests", async () => {
    let capturedHeaders: Record<string, string> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      capturedHeaders = opts.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedHeaders).not.toBeNull();
    expect((capturedHeaders as Record<string, unknown> | null)?.["X-GitHub-Api-Version"]).toBe(
      "2026-06-01",
    );
  });

  it("sends bare catalog name when model is copilot/ namespaced", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    global.fetch = (async (_url: unknown, options: unknown) => {
      const opts = options as RequestInit;
      const parsed: unknown = JSON.parse(opts.body as string);
      capturedBody = parsed as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "copilot/claude-sonnet-5",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      expect((capturedBody as Record<string, unknown>).model).toBe("claude-sonnet-5");
    }
  });

  it("passes a non-namespaced model id through unchanged", () => {
    expect(toCopilotWireModel("claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
    expect(toCopilotWireModel("copilot/claude-sonnet-5")).toBe("claude-sonnet-5");
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
          choices: [{ message: { content: "Response" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      expect((capturedBody as Record<string, unknown>).model).toBe("claude-sonnet-4.6");
    }
  });

  it("returns error when API returns non-ok status", async () => {
    global.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("invalid-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("401");
    }
  });

  it("returns error when API returns no choices", async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ choices: [] }),
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no choices");
    }
  });

  it("returns error when API response has no content", async () => {
    global.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: undefined } }],
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no choices");
    }
  });

  it("returns error when fetch throws", async () => {
    global.fetch = (async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
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

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
    };

    const result = await dispatcher.dispatch(request);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Invalid JSON");
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
          choices: [{ message: { content: "Response" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const customEndpoint = "https://custom.endpoint/v1/chat/completions";
    const dispatcher = new CopilotDispatcher("test-token", customEndpoint);
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
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
          choices: [{ message: { content: "Response" } }],
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const dispatcher = new CopilotDispatcher("test-token");
    const request: DispatchRequest = {
      model: "claude-sonnet-4.6",
      prompt: "Say hello",
    };

    await dispatcher.dispatch(request);

    expect(capturedBody).toBeDefined();
    if (capturedBody) {
      expect((capturedBody as Record<string, unknown>).stream).toBe(false);
    }
  });
});
