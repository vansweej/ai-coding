import { describe, expect, it } from "bun:test";

import { classifyError } from "../../src/errors/classify-error";
import type { TimerLike } from "../../src/retry/timeouts";
import {
  DEFAULT_NETWORK_DISPATCH_TIMEOUT_MS,
  DEFAULT_TIMEOUTS,
  TimeoutError,
  resolveDispatchTimeoutMs,
  withAbortableDeadline,
  withDispatchTimeout,
  withPhaseTimeout,
  withRunTimeout,
  withTimeout,
} from "../../src/retry/timeouts";

/**
 * Fake timer: `setTimeout` is captured but never actually scheduled against
 * the real wall clock. Tests "fire" the timeout by invoking the captured
 * callback synchronously, so no real time ever passes.
 */
function makeFakeTimer(): TimerLike & { fire: () => void; cleared: boolean } {
  const state = { cleared: false, callback: undefined as (() => void) | undefined };
  const timer: TimerLike & { fire: () => void; cleared: boolean } = {
    setTimeout: (callback: () => void, _ms: number) => {
      state.callback = callback;
      return "fake-handle";
    },
    clearTimeout: (_handle: unknown) => {
      state.cleared = true;
    },
    fire: () => {
      state.callback?.();
    },
    get cleared() {
      return state.cleared;
    },
  };
  return timer;
}

/** A hanging operation that never resolves on its own -- only the timeout can settle the race. */
function hangingOperation<T>(): Promise<T> {
  return new Promise<T>(() => {
    // never resolves
  });
}

describe("withTimeout", () => {
  it("resolves with the operation's value when it settles before the deadline", async () => {
    const timer = makeFakeTimer();
    const result = await withTimeout(async () => "done", 1000, "test-scope", timer);
    expect(result).toBe("done");
  });

  it("rejects with a TimeoutError when the operation hangs and the fake timer fires", async () => {
    const timer = makeFakeTimer();
    const promise = withTimeout(hangingOperation, 1000, "dispatch", timer);

    // Fire the fake timeout synchronously -- no real wall-clock wait.
    timer.fire();

    await expect(promise).rejects.toThrow(TimeoutError);
    await expect(promise).rejects.toThrow(/dispatch timed out after 1000ms/);
  });

  it("clears the timer handle when the operation wins the race", async () => {
    const timer = makeFakeTimer();
    await withTimeout(async () => "ok", 1000, "scope", timer);
    expect(timer.cleared).toBe(true);
  });

  it("clears the timer handle when the timeout wins the race", async () => {
    const timer = makeFakeTimer();
    const promise = withTimeout(hangingOperation, 1000, "scope", timer);
    timer.fire();
    await expect(promise).rejects.toThrow(TimeoutError);
    expect(timer.cleared).toBe(true);
  });
});

describe("classifyError on a TimeoutError produced by withTimeout", () => {
  it("classifies a TimeoutError as transient via its error name", async () => {
    const timer = makeFakeTimer();
    const promise = withTimeout(hangingOperation, 500, "dispatch", timer);
    timer.fire();

    let captured: unknown;
    try {
      await promise;
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(TimeoutError);
    const classification = classifyError(captured);
    expect(classification.kind).toBe("transient");
  });

  it("classifies as transient via the message marker even if name were stripped", () => {
    const err = new Error("phase timed out after 60000ms");
    const classification = classifyError(err);
    expect(classification.kind).toBe("transient");
  });
});

describe("withDispatchTimeout", () => {
  it("returns ok:true with the dispatch value when it resolves before the deadline", async () => {
    const timer = makeFakeTimer();
    const result = await withDispatchTimeout(
      async () => ({ ok: true as const, value: "response text" }),
      1000,
      timer,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("response text");
  });

  it("returns ok:false with a transient-classifiable TimeoutError when the dispatch hangs", async () => {
    const timer = makeFakeTimer();
    const promise = withDispatchTimeout(
      () => hangingOperation<{ ok: true; value: string }>(),
      1000,
      timer,
    );
    timer.fire();

    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(classifyError(result.error).kind).toBe("transient");
      expect(result.error.message).toContain("dispatch timed out");
    }
  });

  it("propagates a genuine dispatch error Result unchanged (not converted to a timeout)", async () => {
    const timer = makeFakeTimer();
    const result = await withDispatchTimeout(
      async () => ({ ok: false as const, error: new Error("Copilot returned 401: unauthorized") }),
      1000,
      timer,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("401");
    }
  });

  it("uses DEFAULT_TIMEOUTS.dispatchMs when no explicit timeout is provided", () => {
    expect(DEFAULT_TIMEOUTS.dispatchMs).toBeGreaterThan(0);
  });
});

describe("withPhaseTimeout", () => {
  it("resolves with the phase's result when it completes before the deadline", async () => {
    const timer = makeFakeTimer();
    const result = await withPhaseTimeout(async () => ({ phaseNumber: 1 }), 1000, timer);
    expect(result).toEqual({ phaseNumber: 1 });
  });

  it("aborts a phase that exceeds its budget with a transient-classifiable TimeoutError", async () => {
    const timer = makeFakeTimer();
    const promise = withPhaseTimeout(
      () => hangingOperation<{ phaseNumber: number }>(),
      1000,
      timer,
    );
    timer.fire();

    let captured: unknown;
    try {
      await promise;
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(TimeoutError);
    expect((captured as Error).message).toContain("phase timed out after 1000ms");
    expect(classifyError(captured).kind).toBe("transient");
  });

  it("uses DEFAULT_TIMEOUTS.phaseMs when no explicit timeout is provided", () => {
    expect(DEFAULT_TIMEOUTS.phaseMs).toBeGreaterThan(0);
  });
});

describe("withRunTimeout", () => {
  it("resolves with the run's result when it completes before the deadline", async () => {
    const timer = makeFakeTimer();
    const result = await withRunTimeout(async () => "run-complete", 1000, timer);
    expect(result).toBe("run-complete");
  });

  it("aborts a run that exceeds its budget with a transient-classifiable TimeoutError", async () => {
    const timer = makeFakeTimer();
    const promise = withRunTimeout(() => hangingOperation<string>(), 1000, timer);
    timer.fire();

    let captured: unknown;
    try {
      await promise;
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(TimeoutError);
    expect((captured as Error).message).toContain("run timed out after 1000ms");
    expect(classifyError(captured).kind).toBe("transient");
  });

  it("uses DEFAULT_TIMEOUTS.runMs when no explicit timeout is provided", () => {
    expect(DEFAULT_TIMEOUTS.runMs).toBeGreaterThan(0);
  });
});

describe("resolveDispatchTimeoutMs", () => {
  it("uses a valid positive integer env value in seconds (× 1000)", () => {
    const ms = resolveDispatchTimeoutMs(900_000, { AI_CODING_DISPATCH_TIMEOUT_SECONDS: "30" });
    expect(ms).toBe(30_000);
  });

  it("ignores a non-integer or non-positive env value and uses the provider default", () => {
    expect(resolveDispatchTimeoutMs(900_000, { AI_CODING_DISPATCH_TIMEOUT_SECONDS: "0" })).toBe(
      900_000,
    );
    expect(resolveDispatchTimeoutMs(900_000, { AI_CODING_DISPATCH_TIMEOUT_SECONDS: "1.5" })).toBe(
      900_000,
    );
    expect(resolveDispatchTimeoutMs(900_000, { AI_CODING_DISPATCH_TIMEOUT_SECONDS: "nope" })).toBe(
      900_000,
    );
  });

  it("falls back to the network default when no env value and no provider default", () => {
    expect(resolveDispatchTimeoutMs(undefined, {})).toBe(DEFAULT_NETWORK_DISPATCH_TIMEOUT_MS);
  });
});

describe("withAbortableDeadline", () => {
  it("returns the call value and clears the timer when the call wins", async () => {
    const timer = makeFakeTimer();
    const result = await withAbortableDeadline(
      async (_signal) => ({ ok: true as const, value: "ok" }),
      1000,
      "model dispatch",
      timer,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("ok");
    expect(timer.cleared).toBe(true);
  });

  it("fires the deadline: TimeoutError result, signal aborted, message in seconds", async () => {
    const timer = makeFakeTimer();
    let seenSignal: AbortSignal | undefined;
    const promise = withAbortableDeadline(
      (signal) => {
        seenSignal = signal;
        return hangingOperation<{ ok: true; value: string }>();
      },
      2000,
      "model dispatch",
      timer,
    );
    timer.fire();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(result.error.message).toBe("model dispatch timed out after 2s");
    }
    expect(seenSignal?.aborted).toBe(true);
    expect(timer.cleared).toBe(true);
  });

  it("returns the TimeoutError even when the call resolves its own error on abort", async () => {
    const timer = makeFakeTimer();
    const promise = withAbortableDeadline(
      (signal) =>
        new Promise<{ ok: false; error: Error }>((resolve) => {
          signal.addEventListener("abort", () => {
            resolve({ ok: false, error: new Error("fetch aborted") });
          });
        }),
      1000,
      "model dispatch",
      timer,
    );
    timer.fire();
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(TimeoutError);
      expect(result.error.message).toBe("model dispatch timed out after 1s");
    }
  });

  it("converts a rejected call into an error Result instead of throwing", async () => {
    const timer = makeFakeTimer();
    const result = await withAbortableDeadline(
      async (_signal) => {
        throw new Error("boom");
      },
      1000,
      "model dispatch",
      timer,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("boom");
    expect(timer.cleared).toBe(true);
  });
});
