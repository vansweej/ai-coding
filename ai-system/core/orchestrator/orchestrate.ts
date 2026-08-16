import type {
  AIRequestEvent,
  AIResponse,
  DispatchRequest,
  ModelDispatcher,
  PatchOp,
  Result,
} from "@ai-coding/shared";

import { classifyError } from "../../../src/errors/classify-error";
import { makeDiagnosis, diagnosisToLedgerLine } from "../../../src/diagnosis/diagnosis-record";
import { createLedgerWriter } from "../../../src/ledger/ledger-writer";
import type { ModelProfile } from "../../config/model-profiles";
import { resolveModelForRole } from "../../config/model-profiles";
import { resolveMode } from "../mode-router/resolve-mode";
import { actionToRole } from "../model-router/action-to-role";
import { selectModel } from "../model-router/select-model";
import type { CerebrumMemory } from "./cerebrum-memory";
import { patchModeForModel } from "./patch-capability";

/** Configuration for the orchestrator, mapping model names to dispatchers. */
export interface OrchestratorConfig {
  readonly dispatchers: Record<string, ModelDispatcher>;
  /**
   * When set, model selection uses role-based profile routing instead of the
   * legacy action+mode heuristic. All dispatchers required by the profile must
   * be present in the `dispatchers` map.
   */
  readonly profile?: ModelProfile;
  /**
   * Optional memory client for two-tier memory (Synapse + Cortex).
   * When provided, the orchestrator can store and retrieve memories.
   */
  readonly memory?: CerebrumMemory;
  /**
   * When true, strict mode is enabled: warnings are treated as errors and
   * stricter validation is enforced across pipeline steps.
   */
  readonly strict?: boolean;
}

/** Optional LLM-level parameters forwarded to the dispatcher. */
export interface LLMOptions {
  /** System prompt prepended before the user message. */
  readonly system?: string;
  /** Sampling temperature (0.0–1.0). Provider default is used when omitted. */
  readonly temperature?: number;
  /** Maximum number of tokens to generate. Provider default is used when omitted. */
  readonly maxTokens?: number;
}

/**
 * Resolve the model-ID for an event exactly as `orchestrate()` does, and
 * look up its dispatcher. Shared by both `orchestrate()` and
 * `orchestratePatch()` so model resolution is never forked between the two
 * facades.
 */
/**
 * Emit a lightweight `diagnosis` ledger line for a single retried transient
 * failure (attempt index + classification reason), BEFORE the backoff sleep
 * that precedes the next dispatch attempt. Distinct from the terminal
 * `transient-exhaustion` record: this fires on every retried attempt, not
 * only when the retry budget is exhausted. Never throws -- a ledger-write
 * failure must never mask or interrupt the original dispatch flow.
 */
function emitTransientRetryDiagnosis(
  attemptIndex: number,
  reason: string,
  model: string,
  errorMessage: string,
): void {
  try {
    const record = makeDiagnosis(
      "unknown-run-id",
      "transient-retry",
      "Retrying after a transient dispatch failure",
      `Attempt ${attemptIndex} for model "${model}" failed transiently (${reason}): ${errorMessage}`,
    );
    const ledgerResult = createLedgerWriter("unknown-run-id");
    if (ledgerResult.ok) {
      ledgerResult.value.write(diagnosisToLedgerLine(record));
    }
  } catch {
    // Never let diagnostic emission failure mask the original dispatch flow.
  }
}

function resolveDispatcher(
  event: AIRequestEvent,
  config: OrchestratorConfig,
): { model: string; dispatcher: ModelDispatcher | undefined } {
  const model = config.profile
    ? resolveModelForRole(actionToRole(event.action), config.profile)
    : selectModel(event, resolveMode(event.source));

  return { model, dispatcher: config.dispatchers[model] };
}

/**
 * Write the same memory record `orchestrate()` writes, shared by both
 * facades so the side-effect is never silently forked or dropped on the
 * structured path.
 */
async function writeMemory(
  config: OrchestratorConfig,
  params: {
    action: AIRequestEvent["action"];
    model: string;
    mode: string;
    prompt: string;
    response: string;
    startedAt: number;
  },
): Promise<void> {
  if (!config.memory) {
    return;
  }

  const memoryContent = JSON.stringify({
    action: params.action,
    model: params.model,
    mode: params.mode,
    prompt: params.prompt,
    response: params.response,
    timestamp: params.startedAt,
  });

  await config.memory.remember(memoryContent, 0.6);
}

/**
 * Orchestrate the full request lifecycle:
 * 1. Resolve operating mode from event source
 * 2. Select the appropriate model
 * 3. Dispatch the prompt to the selected model's backend
 * 4. Store the response in memory (if memory client is available)
 * 5. Return a structured response envelope
 */
export async function orchestrate(
  event: AIRequestEvent,
  config: OrchestratorConfig,
  llmOptions?: LLMOptions,
): Promise<Result<AIResponse>> {
  const startedAt = Date.now();

  const mode = resolveMode(event.source);
  const { model, dispatcher } = resolveDispatcher(event, config);

  if (!dispatcher) {
    return {
      ok: false,
      error: new Error(`No dispatcher configured for model "${model}"`),
    };
  }

  const prompt = event.payload.input ?? "";
  const dispatchRequest: DispatchRequest = {
    model,
    prompt,
    system: llmOptions?.system,
    temperature: llmOptions?.temperature,
    maxTokens: llmOptions?.maxTokens,
    context: event.context,
  };
  let result = await dispatcher.dispatch(dispatchRequest);
  let transientAttempts = 1;

  if (!result.ok) {
    const classification = classifyError(result.error);
    if (classification.kind === "transient") {
      emitTransientRetryDiagnosis(1, classification.reason, model, result.error.message);
      transientAttempts++;
      result = await dispatcher.dispatch(dispatchRequest);
    }
  }

  if (!result.ok) {
    const classification = classifyError(result.error);
    if (classification.kind === "transient") {
      const record = makeDiagnosis(
        "unknown-run-id",
        "transient-exhaustion",
        "Transient-eligible retry budget exhausted",
        `Dispatch failed after ${transientAttempts} attempt(s) for model "${model}": ${result.error.message}`,
      );
      try {
        const ledgerResult = createLedgerWriter("unknown-run-id");
        if (ledgerResult.ok) {
          ledgerResult.value.write(diagnosisToLedgerLine(record));
        }
      } catch {
        // Never let diagnostic emission failure mask the original error.
      }
    }
    return result;
  }

  const durationMs = Date.now() - startedAt;

  const response: AIResponse = {
    model,
    mode,
    action: event.action,
    response: result.value,
    timing: { startedAt, durationMs },
  };

  await writeMemory(config, {
    action: event.action,
    model,
    mode,
    prompt,
    response: result.value,
    startedAt,
  });

  return {
    ok: true,
    value: response,
  };
}

/**
 * Outcome of a structured-patch dispatch attempt via `orchestratePatch()`.
 * `"not-capable"` signals the caller to fall back to the string
 * `orchestrate()` path + the existing aider-text/parsePatch loop -- it is
 * NOT an error, just "this model/attempt doesn't support structured output".
 * `reason` distinguishes a text-mode model-ID (`"text-mode"`) from a
 * structured-capable model whose resolved dispatcher lacks a `dispatchPatch`
 * channel (`"no-dispatch-patch"`).
 */
export type PatchStructuredOutcome =
  | { readonly kind: "structured"; readonly ops: readonly PatchOp[] }
  | { readonly kind: "not-capable"; readonly reason: "text-mode" | "no-dispatch-patch" };

/**
 * Structured-output counterpart to `orchestrate()`. Resolves the model and
 * its dispatcher IDENTICALLY to `orchestrate()` (never forked -- see
 * `resolveDispatcher`), feature-detects `dispatchPatch` on the resolved
 * dispatcher, and either returns the model's structured `PatchOp[]` or
 * signals `{ kind: "not-capable" }` so the caller falls back to the string
 * path.
 *
 * Capability is recomputed on EVERY call from the action-resolved model-ID
 * (never cached/resolved once up front), so a profile whose per-role model
 * mix flips backends mid-run (e.g. HYBRID_PROFILE's implementer vs. fixer)
 * is handled correctly without any extra plumbing in callers.
 *
 * This is the ONLY seam that reaches `config.dispatchers` for the
 * structured path; pipeline steps must call this facade rather than
 * indexing `config.dispatchers` themselves, so model resolution and the
 * memory side-effect below are never duplicated/forked from `orchestrate()`.
 */
export async function orchestratePatch(
  event: AIRequestEvent,
  config: OrchestratorConfig,
  llmOptions?: LLMOptions,
): Promise<Result<PatchStructuredOutcome>> {
  const startedAt = Date.now();
  const mode = resolveMode(event.source);
  const { model, dispatcher } = resolveDispatcher(event, config);

  if (!dispatcher) {
    return {
      ok: false,
      error: new Error(`No dispatcher configured for model "${model}"`),
    };
  }

  if (patchModeForModel(model) === "text") {
    return { ok: true, value: { kind: "not-capable", reason: "text-mode" } };
  }

  if (dispatcher.dispatchPatch === undefined) {
    return { ok: true, value: { kind: "not-capable", reason: "no-dispatch-patch" } };
  }

  const prompt = event.payload.input ?? "";
  const dispatchRequest: DispatchRequest = {
    model,
    prompt,
    system: llmOptions?.system,
    temperature: llmOptions?.temperature,
    maxTokens: llmOptions?.maxTokens,
    context: event.context,
  };

  const result = await dispatcher.dispatchPatch(dispatchRequest);
  if (!result.ok) {
    return result;
  }

  await writeMemory(config, {
    action: event.action,
    model,
    mode,
    prompt,
    response: JSON.stringify(result.value),
    startedAt,
  });

  return { ok: true, value: { kind: "structured", ops: result.value } };
}
