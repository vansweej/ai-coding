import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";
import {
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Number of attempts (initial + retries) the underlying AWS SDK client makes
 * for retryable errors (ThrottlingException, ModelNotReadyException,
 * ServiceUnavailableException) before giving up. The SDK's default
 * "standard" retry strategy applies exponential backoff with jitter between
 * attempts, so this is not reimplemented here.
 */
const DEFAULT_MAX_ATTEMPTS = 5;

interface AnthropicTextBlock {
  readonly type: string;
  readonly text: string;
}

interface AnthropicMessageResponse {
  readonly content: readonly AnthropicTextBlock[];
}

/** Minimal shape of the Bedrock client this dispatcher depends on (testable seam). */
export interface BedrockInvoker {
  send(command: InvokeModelCommand): Promise<{ body: Uint8Array }>;
}

/**
 * Extract the AWS region from a Bedrock ARN.
 *
 * ARN shape: arn:aws:bedrock:<region>:<account-id>:application-inference-profile/<id>
 *
 * @param arn - The Bedrock (application) inference profile ARN.
 * @returns The region segment, or undefined if the ARN does not match the expected shape.
 */
export function parseRegionFromBedrockArn(arn: string): string | undefined {
  const parts = arn.split(":");
  // arn : aws : bedrock : region : account-id : resource
  return parts.length >= 4 && parts[0] === "arn" ? parts[3] : undefined;
}

/**
 * Dispatcher that sends prompts to Anthropic models hosted on Amazon Bedrock
 * via the InvokeModel API.
 *
 * Differs from the native AnthropicDispatcher in several ways: authentication
 * uses the AWS SDK credential chain (SSO, profiles, IMDS, etc.) instead of an
 * API key; the model is invoked by ARN (an application-inference-profile ARN
 * in this repo's setup) rather than by model-ID string, so `request.model` is
 * intentionally ignored; `anthropic_version` is a body field (not an HTTP
 * header); the request body must NOT include a `model` field; and the
 * response body is returned as raw bytes (`Uint8Array`), requiring manual
 * UTF-8 decoding and JSON parsing before reaching `content[0].text`.
 *
 * The inference-profile ARN is intentionally a constructor argument (read
 * from an environment variable by the caller) rather than a hardcoded value,
 * because application-inference-profile ARNs embed an AWS account ID and
 * must never be committed to source control.
 */
export class BedrockDispatcher implements ModelDispatcher {
  private readonly client: BedrockInvoker;
  private readonly inferenceProfileArn: string;

  /**
   * @param client              - Bedrock runtime client (or a test double). Defaults to a real
   *                               BedrockRuntimeClient configured for the given region with the
   *                               AWS SDK's standard retry strategy.
   * @param inferenceProfileArn - The Bedrock (application) inference profile ARN to invoke.
   * @param region              - AWS region for the default client. Ignored when a custom
   *                               `client` is provided.
   */
  constructor(
    inferenceProfileArn: string,
    region: string,
    client?: BedrockInvoker,
    clientConfig?: BedrockRuntimeClientConfig,
  ) {
    this.inferenceProfileArn = inferenceProfileArn;
    this.client =
      client ??
      new BedrockRuntimeClient({
        region,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        ...clientConfig,
      });
  }

  /**
   * Dispatch a prompt to the Bedrock InvokeModel API and return the response text.
   *
   * @param request - The prompt and optional system/temperature/maxTokens.
   *                  `request.model` is ignored; the constructor-provided
   *                  inference profile ARN is always used as the invoke target.
   */
  async dispatch(request: DispatchRequest): Promise<Result<string>> {
    try {
      const body: Record<string, unknown> = {
        anthropic_version: BEDROCK_ANTHROPIC_VERSION,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      };

      if (request.system !== undefined) body.system = request.system;
      if (request.temperature !== undefined) body.temperature = request.temperature;

      const command = new InvokeModelCommand({
        modelId: this.inferenceProfileArn,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
      });

      const response = await this.client.send(command);
      const decoded = new TextDecoder().decode(response.body);
      const data = JSON.parse(decoded) as AnthropicMessageResponse;
      const content = data.content[0]?.text;

      if (content === undefined) {
        return { ok: false, error: new Error("Bedrock returned no content") };
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
