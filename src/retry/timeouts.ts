/**
 * Layered timeout primitives for the plan-cycle pipeline.
 *
 * Three scopes are supported, all additive on top of the existing per-step
 * gate timeout (see `shell-step.ts`'s own internal timeout, which remains
 * unchanged and is not superseded by this module):
 *
 *   - dispatch: wraps a single `ModelDispatcher.dispatch`/`dispatchPatch`
 *     call with a deadline.
 *   - phase: wraps an entire phase's implement+verify budget.
 *   - run: wraps the entire plan-cycle run's budget.
 *
 * On timeout, `withTimeout` rejects with a `TimeoutError` whose message is
 * recognized by `classifyError` (src/errors/classify-error.ts) as
 * `transient` -- both because `TimeoutError` is a known transient error
 * `name`, and because the message itself contains the word "timed out",
 * which also matches `classifyError`'s transient message markers. This
 * feeds retry eligibility (S6a) the same way a network error would.
 *
 * `withTimeout` is sleep/clock-injectable so tests never wait on the real
 * wall clock: pass a `scheduleTimeout`/`clearTimeout`-shaped pair (defaults
 * to the real globals) to run deterministically against a fake timer.
 */

/** Thrown (as the rejection reason) when a `withTimeout`-wrapped operation exceeds its deadline. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Injectable timer primitives, so callers can substitute fake timers in tests. */
export interface TimerLike {
  readonly setTimeout: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

const REAL_TIMERS: TimerLike = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Wrap `operation` with a deadline of `timeoutMs`. If `operation` does not
 * settle before the deadline, the returned promise rejects with a
 * `TimeoutError` carrying `label` in its message (e.g. "dispatch", "phase",
 * "run") for diagnostic clarity. The timer is always cleared, whether the
 * operation wins or loses the race, so no dangling handle survives.
 *
 * @param operation  - The async operation to bound.
 * @param timeoutMs  - The deadline in milliseconds.
 * @param label      - Human-readable scope name embedded in the timeout message.
 * @param timers     - Injectable timer primitives; defaults to the real globals.
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
  timers: TimerLike = REAL_TIMERS,
): Promise<T> {
  let timeoutHandle: unknown;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = timers.setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    timers.clearTimeout(timeoutHandle);
  }
}

/** Default timeout budgets (milliseconds) for each scope. */
export const DEFAULT_TIMEOUTS = {
  dispatchMs: 120_000,
  phaseMs: 1_800_000,
  runMs: 21_600_000,
} as const;

/**
 * Wrap a `ModelDispatcher.dispatch`/`dispatchPatch`-shaped call (returns a
 * `Result<T>`, never throws) with a dispatch-scoped timeout. On timeout,
 * returns `{ ok: false, error: TimeoutError }` instead of rejecting, so
 * callers that only handle `Result` (not promise rejection) still observe
 * the timeout as a transient, classifiable error.
 *
 * @param dispatchCall - A thunk invoking the dispatcher.
 * @param timeoutMs    - Dispatch-scoped deadline; defaults to `DEFAULT_TIMEOUTS.dispatchMs`.
 * @param timers       - Injectable timer primitives; defaults to the real globals.
 */
export async function withDispatchTimeout<T>(
  dispatchCall: () => Promise<{ ok: true; value: T } | { ok: false; error: Error }>,
  timeoutMs: number = DEFAULT_TIMEOUTS.dispatchMs,
  timers: TimerLike = REAL_TIMERS,
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try {
    return await withTimeout(dispatchCall, timeoutMs, "dispatch", timers);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Wrap a phase-scoped operation with a timeout. Unlike `withDispatchTimeout`,
 * this rethrows (does not convert to `Result`) since phase execution already
 * uses throw/reject-based control flow at this scope in some call sites;
 * callers that want a `Result` should catch and convert themselves.
 *
 * @param phaseCall - A thunk executing the phase's full implement+verify cycle.
 * @param timeoutMs - Phase-scoped deadline; defaults to `DEFAULT_TIMEOUTS.phaseMs`.
 * @param timers    - Injectable timer primitives; defaults to the real globals.
 */
export async function withPhaseTimeout<T>(
  phaseCall: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUTS.phaseMs,
  timers: TimerLike = REAL_TIMERS,
): Promise<T> {
  return withTimeout(phaseCall, timeoutMs, "phase", timers);
}

/**
 * Wrap a run-scoped operation (the entire plan-cycle invocation) with a
 * timeout.
 *
 * @param runCall   - A thunk executing the entire run.
 * @param timeoutMs - Run-scoped deadline; defaults to `DEFAULT_TIMEOUTS.runMs`.
 * @param timers    - Injectable timer primitives; defaults to the real globals.
 */
export async function withRunTimeout<T>(
  runCall: () => Promise<T>,
  timeoutMs: number = DEFAULT_TIMEOUTS.runMs,
  timers: TimerLike = REAL_TIMERS,
): Promise<T> {
  return withTimeout(runCall, timeoutMs, "run", timers);
}
