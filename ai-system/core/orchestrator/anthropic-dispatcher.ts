import { PATCH_OPS_JSON_SCHEMA, PATCH_TOOL_NAME } from "@ai-coding/shared";
import type { DispatchRequest, ModelDispatcher, PatchOp, Result } from "@ai-coding/shared";

import { parsePatchOps } from "./patch-contract";
import { boundedPayload } from "./patch-parse-diagnostic";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;

interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}

interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicMessageResponse {
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason?: string;
}

/**
 * Dispatcher that sends prompts to Anthropic's native Messages API.
 *
 * Differs from the OpenAI-style Copilot dispatcher in several ways: the
 * system prompt is a top-level `system` field (not a message), `max_tokens`
 * is required by the API, auth uses `x-api-key` plus an `anthropic-version`
 * header, and responses are read from `content[0].text`.
 */
export class AnthropicDispatcher implements ModelDispatcher {
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(apiKey: string, endpoint: string = ANTHROPIC_MESSAGES_URL) {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  /**
   * Dispatch a prompt to the Anthropic Messages API and return the response text.
   *
   * @param request - The model, prompt, and optional system/temperature/maxTokens.
   */
  async dispatch(request: DispatchRequest): Promise<Result<string>> {
    try {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
      };

      // Anthropic takes the system prompt as a top-level field, not a message.
      if (request.system !== undefined) body.system = request.system;
      if (request.temperature !== undefined) body.temperature = request.temperature;

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "User-Agent": "ai-coding-os/1.0.0",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: new Error(`Anthropic returned ${response.status}: ${await response.text()}`),
        };
      }

      const data = (await response.json()) as AnthropicMessageResponse;
      const textBlock = data.content.find(
        (block): block is AnthropicTextBlock => block.type === "text",
      );
      const content = textBlock?.text;

      if (content === undefined) {
        return { ok: false, error: new Error("Anthropic returned no content") };
      }

      return { ok: true, value: content };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Dispatch a prompt to the Anthropic Messages API, forcing a single
   * `emit_patch` tool call that returns the WHOLE phase's structured patch
   * ops at once (see PATCH_OPS_JSON_SCHEMA). Callers must treat any error
   * Result as a signal to fall back to `dispatch()` + the aider-text parser.
   *
   * @param request - The model, prompt, and optional system/temperature/maxTokens.
   */
  async dispatchPatch(request: DispatchRequest): Promise<Result<readonly PatchOp[]>> {
    try {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
        tools: [
          {
            name: PATCH_TOOL_NAME,
            description:
              "Emit the complete set of file create/edit/move operations for this phase as structured data.",
            input_schema: PATCH_OPS_JSON_SCHEMA,
          },
        ],
        tool_choice: { type: "tool", name: PATCH_TOOL_NAME },
      };

      if (request.system !== undefined) body.system = request.system;
      if (request.temperature !== undefined) body.temperature = request.temperature;

      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "User-Agent": "ai-coding-os/1.0.0",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        return {
          ok: false,
          error: new Error(`Anthropic returned ${response.status}: ${await response.text()}`),
        };
      }

      const data = (await response.json()) as AnthropicMessageResponse;

      // A truncated tool call (cut off mid-JSON) can never parse correctly --
      // fail fast rather than attempt to parse partial input.
      if (data.stop_reason === "max_tokens") {
        return {
          ok: false,
          error: new Error("Anthropic response truncated at max_tokens mid tool-call"),
        };
      }

      // The model may return both a text block (e.g. commentary) and a
      // tool_use block; select the tool_use block by name explicitly rather
      // than assuming position.
      const toolUseBlock = data.content.find(
        (block): block is AnthropicToolUseBlock =>
          block.type === "tool_use" && block.name === PATCH_TOOL_NAME,
      );

      if (toolUseBlock === undefined) {
        return {
          ok: false,
          error: new Error(`Anthropic response contained no "${PATCH_TOOL_NAME}" tool_use block`),
        };
      }

      const parsed = parsePatchOps(toolUseBlock.input);
      if (!parsed.ok) {
        return { ok: false, error: new Error(`patch parse failed: ${parsed.error.message}\npayload: ${boundedPayload(JSON.stringify(toolUseBlock.input))}`, { cause: parsed.error }) };
      }

      return { ok: true, value: parsed.value };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
