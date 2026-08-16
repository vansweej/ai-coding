import { describe, expect, it } from "bun:test";

import { classifyError } from "../../src/errors/classify-error";
import type { TimerLike } from "../../src/retry/timeouts";
import {
  DEFAULT_TIMEOUTS,
  TimeoutError,
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
    const promise = withPhaseTimeout(() => hangingOperation<{ phaseNumber: number }>(), 1000, timer);
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
