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

/** Environment variable name overriding the per-dispatch deadline, in positive integer seconds. */
export const DISPATCH_TIMEOUT_ENV = "AI_CODING_DISPATCH_TIMEOUT_SECONDS";

/**
 * Network-dispatch default deadline (ms). P2 raised the implement/fix output
 * budget to 16,384 tokens, so a full-budget cloud completion can legitimately
 * take minutes; 300s avoids aborting slow-but-healthy completions. This is a
 * new constant kept separate from `DEFAULT_TIMEOUTS.dispatchMs` so the existing
 * layered-timeout budgets are untouched.
 */
export const DEFAULT_NETWORK_DISPATCH_TIMEOUT_MS = 300_000;

/**
 * Resolve the per-dispatch deadline (ms). An `AI_CODING_DISPATCH_TIMEOUT_SECONDS`
 * value that parses to a positive integer wins (× 1000). Otherwise the
 * provider-specific default is used, falling back to the network default when
 * no provider default is supplied. Pure: reads the injected `env` object only.
 *
 * @param providerDefaultMs - The dispatcher's own default deadline, if any.
 * @param env - Environment map; defaults to `process.env`.
 */
export function resolveDispatchTimeoutMs(
  providerDefaultMs: number | undefined,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[DISPATCH_TIMEOUT_ENV];
  if (raw !== undefined) {
    const seconds = Number(raw);
    if (Number.isInteger(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }
  return providerDefaultMs ?? DEFAULT_NETWORK_DISPATCH_TIMEOUT_MS;
}

/**
 * Run a dispatch-shaped call (returns a `Result`, never throws) under an
 * abortable deadline. An `AbortController` is created and its `signal` is
 * passed to `call`; dispatchers that honour it abort their in-flight fetch on
 * expiry. As a backstop for dispatchers that ignore the signal, the timer also
 * resolves the race with a `TimeoutError` Result, so a hung dispatch can never
 * stall the run. If `call` settles first the timer is cleared; if the deadline
 * fires first, the timeout wins and any late result from the aborted call is
 * ignored. Never throws: rejections and synchronous throws from `call` are
 * caught and returned as an error `Result`. Timers are injectable so tests run
 * on a fake clock.
 *
 * @param call - Invoked with the abort signal; returns a `Result`.
 * @param timeoutMs - The deadline in milliseconds.
 * @param label - Human-readable scope embedded in the timeout message.
 * @param timers - Injectable timer primitives; defaults to the real globals.
 */
export async function withAbortableDeadline<T>(
  call: (signal: AbortSignal) => Promise<{ ok: true; value: T } | { ok: false; error: Error }>,
  timeoutMs: number,
  label: string,
  timers: TimerLike = REAL_TIMERS,
): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  const controller = new AbortController();
  let timeoutHandle: unknown;
  const timeoutError = new TimeoutError(
    `${label} timed out after ${Math.round(timeoutMs / 1000)}s`,
  );

  const timeoutPromise = new Promise<{ ok: false; error: Error }>((resolve) => {
    timeoutHandle = timers.setTimeout(() => {
      controller.abort(timeoutError);
      resolve({ ok: false, error: timeoutError });
    }, timeoutMs);
  });

  const toErrorResult = (error: unknown): { ok: false; error: Error } => ({
    ok: false,
    error: error instanceof Error ? error : new Error(String(error)),
  });
  let callPromise: Promise<{ ok: true; value: T } | { ok: false; error: Error }>;
  try {
    callPromise = call(controller.signal).catch(toErrorResult);
  } catch (error) {
    callPromise = Promise.resolve(toErrorResult(error));
  }

  try {
    return await Promise.race([callPromise, timeoutPromise]);
  } finally {
    timers.clearTimeout(timeoutHandle);
  }
}

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
