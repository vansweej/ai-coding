/**
 * Pure classifier distinguishing transient (retryable) failures from logic
 * (deterministic) failures, based on the transport-error shapes surfaced by
 * dispatcher implementations (see e.g. `orchestrate.ts`'s
 * "No dispatcher configured" / dispatch Result handling) and the various
 * `ModelDispatcher.dispatch`/`dispatchPatch` implementations across
 * `ai-system/core/orchestrator/*.ts` (network errors, HTTP 5xx/429 status
 * codes, timeouts).
 *
 * `transient` -- the failure is plausibly resolved by retrying the same
 * operation unchanged: network/connection failures, timeouts, rate limiting,
 * and 5xx server errors.
 *
 * `logic` -- the failure is deterministic and retrying the same input
 * without changing it will reproduce the same failure: validation errors,
 * assertion failures, parse errors, schema mismatches, 4xx client errors
 * (other than 429).
 *
 * Unknown/unclassifiable errors default to `logic` (documented boundary
 * case): treating an unrecognized error as retryable risks infinite retry
 * loops against a deterministically-failing operation, whereas treating it
 * as non-retryable simply surfaces the failure once, which is the safer
 * default.
 *
 * This function is pure: it performs no I/O, no side effects, and never
 * throws -- any input (including non-Error values) is handled defensively.
 */

export interface ErrorClassification {
  readonly kind: "transient" | "logic";
  readonly reason: string;
}

/** Lowercase substrings that indicate a transient/retryable failure. */
const TRANSIENT_MESSAGE_MARKERS: readonly string[] = [
  "network error",
  "connection refused",
  "connection reset",
  "econnrefused",
  "econnreset",
  "etimedout",
  "enotfound",
  "eai_again",
  "timed out",
  "timeout",
  "rate limit",
  "rate exceeded",
  "too many requests",
  "throttl",
  "fetch not mobbed", // never matches; placeholder guarded intentionally removed below
];

/** Lowercase substrings that indicate a deterministic/logic failure. */
const LOGIC_MESSAGE_MARKERS: readonly string[] = [
  "validation",
  "invalid",
  "assertion",
  "unexpected",
  "parse",
  "schema",
  "malformed",
  "unauthorized",
  "forbidden",
  "not found",
  "bad request",
];

/** Error names known to represent transient conditions. */
const TRANSIENT_ERROR_NAMES: readonly string[] = [
  "ThrottlingException",
  "ServiceUnavailableException",
  "ModelNotReadyException",
  "TimeoutError",
  "AbortError",
];

/**
 * Extract an embedded HTTP status code from a message of the form
 * `"... returned <status>: ..."` (the shape used by every dispatcher in
 * this codebase, e.g. `Copilot returned 401: ...`, `Anthropic returned 500: ...`).
 */
function extractHttpStatus(message: string): number | undefined {
  const match = /\breturned (\d{3})\b/.exec(message);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isInteger(status) ? status : undefined;
}

function messageContainsAny(message: string, markers: readonly string[]): boolean {
  const lower = message.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

/**
 * Classify an error as `transient` (retryable) or `logic` (deterministic).
 *
 * Classification precedence:
 *   1. A known transient error `name` (e.g. `ThrottlingException`).
 *   2. An embedded HTTP status code: 429 or 5xx => transient; 4xx (other
 *      than 429) => logic.
 *   3. A transient message marker (network/timeout/rate-limit language).
 *   4. A logic message marker (validation/parse/schema language).
 *   5. Unknown/unclassifiable => `logic` (documented default).
 *
 * @param err - Any thrown or returned error value (Error, string, or other).
 */
export function classifyError(err: unknown): ErrorClassification {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : undefined;

  if (name !== undefined && TRANSIENT_ERROR_NAMES.includes(name)) {
    return { kind: "transient", reason: `known transient error name: ${name}` };
  }

  const status = extractHttpStatus(message);
  if (status !== undefined) {
    if (status === 429 || (status >= 500 && status < 600)) {
      return { kind: "transient", reason: `HTTP status ${status} indicates a transient failure` };
    }
    if (status >= 400 && status < 500) {
      return { kind: "logic", reason: `HTTP status ${status} indicates a client/logic failure` };
    }
  }

  if (messageContainsAny(message, TRANSIENT_MESSAGE_MARKERS)) {
    return { kind: "transient", reason: "message matches a transient/network failure pattern" };
  }

  if (messageContainsAny(message, LOGIC_MESSAGE_MARKERS)) {
    return { kind: "logic", reason: "message matches a validation/logic failure pattern" };
  }

  return { kind: "logic", reason: "unclassified error defaults to logic (non-retryable)" };
}
