// HARD RULE: this file imports nothing. PatchOp/schema live here so both
// parse-patch.ts and patch-contract.ts may depend on it, never the reverse.
// @ai-coding/shared resolves to this single file (tsconfig path alias) and
// is the root of the dependency graph; adding an import here would create a
// cycle with anything under ai-system/core/pipeline or ai-system/core/orchestrator.

export type AISource = "nvim" | "cli" | "agent" | "api";

export type AIModeHint = "editor" | "agentic" | "auto";

export type AIAction =
  | "explain"
  | "edit"
  | "refactor"
  | "plan"
  | "debug"
  | "fix"
  | "chat"
  | "task"
  | "explore";

export interface AIRequestEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly source: AISource;
  readonly modeHint?: AIModeHint;
  readonly action: AIAction;
  readonly payload: {
    readonly input?: string;
    readonly file?: string;
    readonly selection?: string;
    readonly workspace?: string;
    readonly metadata?: Record<string, unknown>;
  };
  readonly context?: Record<string, unknown>;
}

/** Resolved operating mode after mode-router decision. */
export type AIMode = "editor" | "agentic";

/** Structured response envelope returned by the orchestrator. */
export interface AIResponse {
  readonly model: string;
  readonly mode: AIMode;
  readonly action: AIAction;
  readonly response: string;
  readonly timing: {
    readonly startedAt: number;
    readonly durationMs: number;
  };
}

/** Request payload sent to a model dispatcher. */
export interface DispatchRequest {
  readonly model: string;
  readonly prompt: string;
  /** Optional system prompt prepended before the user message. */
  readonly system?: string;
  /** Sampling temperature (0.0–1.0). Provider default is used when omitted. */
  readonly temperature?: number;
  /** Maximum number of tokens to generate. Provider default is used when omitted. */
  readonly maxTokens?: number;
  readonly context?: Record<string, unknown>;
}

/**
 * Interface for sending prompts to a model backend.
 * Implementations handle the HTTP transport for a specific provider.
 */
export interface ModelDispatcher {
  dispatch(request: DispatchRequest): Promise<Result<string>>;
  /**
   * Optional structured-output channel. Present only on backends that can
   * guarantee valid structured data (native tool-use, OpenAI tool_calls,
   * or grammar/JSON-schema constrained decoding). Called ONLY by
   * `orchestratePatch()` in ai-system/core/orchestrator/orchestrate.ts —
   * never directly by pipeline steps. Callers must feature-detect this
   * method and fall back to `dispatch()` + the aider-text parser when it
   * is absent.
   */
  dispatchPatch?(request: DispatchRequest): Promise<Result<readonly PatchOp[]>>;
}

/** Discriminated result type for operations that can fail predictably. */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/**
 * A single structured patch operation, as emitted by a structured-capable
 * model backend (native tool-use / tool_calls / constrained decoding).
 *
 * This is the WIRE shape a model emits — a discriminated union on `kind` so
 * a JSON Schema can constrain each variant cleanly. It is converted to the
 * applier's internal `PatchEdit` flags-on-one-struct shape (see
 * ai-system/core/pipeline/steps/parse-patch.ts) by `patchOpsToEdits` in
 * ai-system/core/orchestrator/patch-contract.ts before reaching `applyPatch`.
 */
export type PatchOp =
  | { readonly kind: "create"; readonly filePath: string; readonly contents: string }
  | { readonly kind: "move"; readonly filePath: string; readonly toPath: string }
  | {
      readonly kind: "edit";
      readonly filePath: string;
      readonly search: string;
      readonly replace: string;
    };

/** Name of the forced tool/function every structured-capable dispatcher exposes. */
export const PATCH_TOOL_NAME = "emit_patch";

/**
 * Provider-neutral JSON Schema describing `{ ops: PatchOp[] }`. This single
 * literal is reused by every structured backend: Anthropic `input_schema`,
 * OpenAI-shaped `function.parameters` (Copilot/Zen), and Ollama `format`
 * (constrained decoding). Keep this in sync with the `PatchOp` union above.
 */
export const PATCH_OPS_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    ops: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "create" },
              filePath: { type: "string" },
              contents: { type: "string" },
            },
            required: ["kind", "filePath", "contents"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "move" },
              filePath: { type: "string" },
              toPath: { type: "string" },
            },
            required: ["kind", "filePath", "toPath"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              kind: { const: "edit" },
              filePath: { type: "string" },
              search: { type: "string" },
              replace: { type: "string" },
            },
            required: ["kind", "filePath", "search", "replace"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["ops"],
  additionalProperties: false,
};
