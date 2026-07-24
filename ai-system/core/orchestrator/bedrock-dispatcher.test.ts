import { describe, expect, it } from "bun:test";

import type { DispatchRequest } from "@ai-coding/shared";
import type { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

import type { BedrockInvoker } from "./bedrock-dispatcher";
import { BedrockDispatcher, parseRegionFromBedrockArn } from "./bedrock-dispatcher";

const TEST_ARN =
  "arn:aws:bedrock:eu-west-1:953734003896:application-inference-profile/mekgfwxmx7tr";

/** Build a minimal DispatchRequest. Note: `model` is always ignored by BedrockDispatcher. */
function makeRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    model: "bedrock-sonnet",
    prompt: "Say hello",
    ...overrides,
  };
}

/** Encode a Bedrock/Anthropic-shaped response body as the raw bytes the SDK returns. */
function encodeResponseBody(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** Create a fake BedrockInvoker that captures the last command and returns a fixed body. */
function makeFakeInvoker(
  responseBody: Uint8Array,
  onSend?: (command: InvokeModelCommand) => void,
): BedrockInvoker {
  return {
    send: async (command: InvokeModelCommand) => {
      onSend?.(command);
      return { body: responseBody };
    },
  };
}

/** Create a fake BedrockInvoker whose send() always rejects. */
function makeThrowingInvoker(error: unknown): BedrockInvoker {
  return {
    send: async () => {
      throw error;
    },
  };
}

function parseSentBody(command: InvokeModelCommand): Record<string, unknown> {
  const raw = command.input.body;
  const text =
    typeof raw === "string" ? raw : new TextDecoder().decode(raw as unknown as Uint8Array);
  return JSON.parse(text) as Record<string, unknown>;
}

describe("parseRegionFromBedrockArn", () => {
  it("extracts the region from an application-inference-profile ARN", () => {
    expect(parseRegionFromBedrockArn(TEST_ARN)).toBe("eu-west-1");
  });

  it("returns undefined for a non-ARN string", () => {
    expect(parseRegionFromBedrockArn("not-an-arn")).toBeUndefined();
  });

  it("returns undefined for a malformed ARN with too few segments", () => {
    expect(parseRegionFromBedrockArn("arn:aws:bedrock")).toBeUndefined();
  });
});

describe("BedrockDispatcher", () => {
  it("constructs with an injected client and ARN", () => {
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeFakeInvoker(new Uint8Array()),
    );
    expect(dispatcher).toBeDefined();
  });

  it("dispatches a simple prompt successfully, decoding the Uint8Array response body", async () => {
    const body = encodeResponseBody({ content: [{ type: "text", text: "Hello, world!" }] });
    const dispatcher = new BedrockDispatcher(TEST_ARN, "eu-west-1", makeFakeInvoker(body));

    const result = await dispatcher.dispatch(makeRequest());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("Hello, world!");
    }
  });

  it("invokes the constructor-provided inference profile ARN, ignoring request.model", async () => {
    let capturedModelId: string | undefined;
    const body = encodeResponseBody({ content: [{ type: "text", text: "ok" }] });
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeFakeInvoker(body, (command) => {
        capturedModelId = command.input.modelId;
      }),
    );

    await dispatcher.dispatch(makeRequest({ model: "some-other-model-id" }));

    expect(capturedModelId).toBe(TEST_ARN);
  });

  it("sets anthropic_version in the body (bedrock-2023-05-31), not as a header", async () => {
    let captured: Record<string, unknown> | undefined;
    const body = encodeResponseBody({ content: [{ type: "text", text: "ok" }] });
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeFakeInvoker(body, (command) => {
        captured = parseSentBody(command);
      }),
    );

    await dispatcher.dispatch(makeRequest());

    expect(captured?.anthropic_version).toBe("bedrock-2023-05-31");
  });

  it("does not include a model field in the request body", async () => {
    let captured: Record<string, unknown> | undefined;
    const body = encodeResponseBody({ content: [{ type: "text", text: "ok" }] });
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeFakeInvoker(body, (command) => {
        captured = parseSentBody(command);
      }),
    );

    await dispatcher.dispatch(makeRequest());

    expect(captured).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(captured ?? {}, "model")).toBe(false);
  });

  it("does not include a stream field (non-streaming InvokeModel only)", async () => {
    let captured: Record<string, unknown> | undefined;
    const body = encodeResponseBody({ content: [{ type: "text", text: "ok" }] });
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeFakeInvoker(body, (command) => {
        captured = parseSentBody(command);
      }),
    );

    await dispatcher.dispatch(makeRequest());

    expect(Object.prototype.hasOwnProperty.call(captured ?? {}, "stream")).toBe(false);
  });

  it("defaults max_tokens to 8192 when not provided", async () => {
    let captured: Record<string, unknown> | undefined;
    const body = encodeResponseBody({ content: [{ type: "text", text: "ok" }] });
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeFakeInvoker(body, (command) => {
        captured = parseSentBody(command);
      }),
    );

    await dispatcher.dispatch(makeRequest());

    expect(captured?.max_tokens).toBe(8192);
  });

  it("uses provided maxTokens when set", async () => {
    let captured: Record<string, unknown> | undefined;
    const body = encodeResponseBody({ content: [{ type: "text", text: "ok" }] });
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeFakeInvoker(body, (command) => {
        captured = parseSentBody(command);
      }),
    );

    await dispatcher.dispatch(makeRequest({ maxTokens: 1000 }));

    expect(captured?.max_tokens).toBe(1000);
  });

  it("includes system prompt as a top-level body field, not a message", async () => {
    let captured: Record<string, unknown> | undefined;
    const body = encodeResponseBody({ content: [{ type: "text", text: "ok" }] });
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeFakeInvoker(body, (command) => {
        captured = parseSentBody(command);
      }),
    );

    await dispatcher.dispatch(makeRequest({ system: "You are a helpful assistant" }));

    expect(captured?.system).toBe("You are a helpful assistant");
    const messages = captured?.messages as Array<{ role: string; content: string }>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("Say hello");
  });

  it("includes temperature when provided", async () => {
    let captured: Record<string, unknown> | undefined;
    const body = encodeResponseBody({ content: [{ type: "text", text: "ok" }] });
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeFakeInvoker(body, (command) => {
        captured = parseSentBody(command);
      }),
    );

    await dispatcher.dispatch(makeRequest({ temperature: 0.7 }));

    expect(captured?.temperature).toBe(0.7);
  });

  it("returns error when Bedrock returns no content", async () => {
    const body = encodeResponseBody({ content: [] });
    const dispatcher = new BedrockDispatcher(TEST_ARN, "eu-west-1", makeFakeInvoker(body));

    const result = await dispatcher.dispatch(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no content");
    }
  });

  it("returns error when the response has no text field", async () => {
    const body = encodeResponseBody({ content: [{ type: "text", text: undefined }] });
    const dispatcher = new BedrockDispatcher(TEST_ARN, "eu-west-1", makeFakeInvoker(body));

    const result = await dispatcher.dispatch(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no content");
    }
  });

  it("returns error when the client throws a ThrottlingException", async () => {
    const throttling = Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeThrowingInvoker(throttling),
    );

    const result = await dispatcher.dispatch(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Rate exceeded");
    }
  });

  it("returns error when the client rejects with a non-Error value", async () => {
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeThrowingInvoker("plain string error"),
    );

    const result = await dispatcher.dispatch(makeRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("plain string error");
    }
  });

  it("returns error when JSON parsing of the response body fails", async () => {
    const dispatcher = new BedrockDispatcher(
      TEST_ARN,
      "eu-west-1",
      makeFakeInvoker(new TextEncoder().encode("not valid json")),
    );

    const result = await dispatcher.dispatch(makeRequest());
    expect(result.ok).toBe(false);
  });

  it("constructs a default BedrockRuntimeClient when no client is injected", () => {
    // Exercises the constructor's default-client branch without making any network call.
    const dispatcher = new BedrockDispatcher(TEST_ARN, "eu-west-1");
    expect(dispatcher).toBeDefined();
  });
});
