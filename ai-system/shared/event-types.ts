export type AISource = "nvim" | "cli" | "agent" | "api";

export type AIModeHint = "editor" | "agentic" | "auto";

export type AIAction =
  | "explain"
  | "edit"
  | "refactor"
  | "plan"
  | "debug"
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
}

/** Discriminated result type for operations that can fail predictably. */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
