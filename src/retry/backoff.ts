/**
 * Pure exponential-backoff-with-full-jitter computation, plus a
 * sleep-injectable retry helper.
 *
 * Full jitter (per the well-known AWS backoff strategies writeup): the
 * delay for a given attempt is a uniformly random value in
 * [0, min(cap, base * 2^attempt)]. This spreads out retries from many
 * concurrent callers without the thundering-herd effect of a fixed
 * exponential schedule.
 *
 * `computeBackoffMs` is pure and deterministic given an injected `random`
 * function (defaults to `Math.random`), so tests can inject a fixed value
 * for deterministic assertions.
 */

export interface BackoffOptions {
  /** Base delay in milliseconds for attempt 0. Defaults to 100. */
  readonly baseMs?: number;
  /** Maximum delay in milliseconds, regardless of attempt. Defaults to 30_000. */
  readonly capMs?: number;
  /** Injectable random source in [0, 1). Defaults to Math.random. */
  readonly random?: () => number;
}

const DEFAULT_BASE_MS = 100;
const DEFAULT_CAP_MS = 30_000;

/**
 * Compute the exponential-backoff-with-full-jitter delay (in milliseconds)
 * for a given retry attempt (0-indexed: attempt 0 is the first retry after
 * the initial attempt).
 *
 * `delay = random() * min(capMs, baseMs * 2^attempt)`
 *
 * Never throws. A negative `attempt` is treated as 0. `baseMs`/`capMs` are
 * clamped to be non-negative.
 *
 * @param attempt - The 0-indexed retry attempt number.
 * @param opts    - Optional base/cap/random overrides.
 */
export function computeBackoffMs(attempt: number, opts?: BackoffOptions): number {
  const baseMs = Math.max(0, opts?.baseMs ?? DEFAULT_BASE_MS);
  const capMs = Math.max(0, opts?.capMs ?? DEFAULT_CAP_MS);
  const random = opts?.random ?? Math.random;
  const safeAttempt = Math.max(0, Math.floor(attempt));

  const exponential = baseMs * 2 ** safeAttempt;
  const ceiling = Math.min(capMs, Number.isFinite(exponential) ? exponential : capMs);

  const r = random();
  const clampedR = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;

  return clampedR * ceiling;
}

/** Injectable sleep function; defaults to a real setTimeout-based sleep. */
export type SleepFn = (ms: number) => Promise<void>;

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export interface RetryWithBackoffOptions extends BackoffOptions {
  /** Maximum number of attempts (including the first). Defaults to 3. */
  readonly maxAttempts?: number;
  /** Injectable sleep function, so tests can avoid real delays. */
  readonly sleep?: SleepFn;
  /**
   * Predicate deciding whether a given error is retry-eligible. When
   * omitted, every rejection is treated as retryable.
   */
  readonly isRetryable?: (error: unknown) => boolean;
}

/**
 * Retry an async operation with exponential-backoff-with-full-jitter delays
 * between attempts. Delegates delay computation to `computeBackoffMs`
 * (never reimplemented locally) and awaits an injectable `sleep` between
 * unsuccessful attempts, so tests can run without real timers.
 *
 * The FIRST attempt runs immediately (no pre-delay). A delay is awaited
 * only BEFORE each retry (i.e. before attempt indices 1..maxAttempts-1).
 *
 * @param operation - The async operation to retry.
 * @param opts      - Retry configuration, including the injectable sleep.
 * @throws The last error encountered, if every attempt fails or the error
 *         is deemed non-retryable by `isRetryable`.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  opts?: RetryWithBackoffOptions,
): Promise<T> {
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? 3);
  const sleep = opts?.sleep ?? defaultSleep;
  const isRetryable = opts?.isRetryable ?? (() => true);

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isRetryable(error)) {
        throw error;
      }

      const delayMs = computeBackoffMs(attempt, opts);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
