/**
 * Hard-fail helper for plan-cycle pipeline phases.
 *
 * Provides a typed reason registry and a factory that constructs a
 * `{ ok: false; error: Error }` result whose `error.name` is set to
 * `"PhaseHardFailError"` for reliable `instanceof`-free identification.
 */

/**
 * Canonical string tokens that identify why a phase hard-failed.
 * Use these values instead of bare strings so callers can switch/match
 * exhaustively without relying on free-form error message parsing.
 */
export const PHASE_FAILURE_REASONS = {
  noNetChange: "noNetChange",
  structuralAssertion: "structuralAssertion",
  dispatchError: "dispatchError",
  conversionFailed: "conversionFailed",
  vacuousPass: "vacuousPass",
} as const;

/**
 * Union of all valid phase-failure reason strings, derived from
 * `PHASE_FAILURE_REASONS` so the type and the runtime value stay in sync.
 */
export type PhaseFailureReason = (typeof PHASE_FAILURE_REASONS)[keyof typeof PHASE_FAILURE_REASONS];

/**
 * Construct a hard-fail result for a plan-cycle phase.
 *
 * Sets `error.name` to `"PhaseHardFailError"` so callers can identify the
 * error class without a fragile `instanceof` check across module boundaries.
 *
 * @param phaseNumber - The 1-indexed phase number that failed.
 * @param reason      - A typed reason token from `PHASE_FAILURE_REASONS`.
 * @param detail      - A human-readable description of the specific failure.
 * @returns `{ ok: false; error: Error }` with the formatted message and name set.
 */
export function phaseHardFail(
  phaseNumber: number,
  reason: PhaseFailureReason,
  detail: string,
): { ok: false; error: Error } {
  const error = new Error(`Phase ${phaseNumber} hard-fail [${reason}]: ${detail}`);
  error.name = "PhaseHardFailError";
  return { ok: false, error };
}
