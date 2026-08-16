import { describe, expect, it } from "bun:test";

import { computeBackoffMs, retryWithBackoff } from "../../src/retry/backoff";

describe("computeBackoffMs", () => {
  it("returns 0 when random() returns 0 (lower jitter bound)", () => {
    const delay = computeBackoffMs(3, { baseMs: 100, capMs: 30_000, random: () => 0 });
    expect(delay).toBe(0);
  });

  it("returns the full ceiling when random() returns just under 1 (upper jitter bound)", () => {
    const delay = computeBackoffMs(2, { baseMs: 100, capMs: 30_000, random: () => 0.999999 });
    // ceiling = min(30000, 100 * 2^2) = 400
    expect(delay).toBeCloseTo(400 * 0.999999, 5);
    expect(delay).toBeLessThan(400);
  });

  it("grows the ceiling monotonically in expectation as attempt increases", () => {
    const fixedRandom = () => 1; // use the ceiling itself for comparison
    const d0 = computeBackoffMs(0, { baseMs: 10, capMs: 100_000, random: fixedRandom });
    const d1 = computeBackoffMs(1, { baseMs: 10, capMs: 100_000, random: fixedRandom });
    const d2 = computeBackoffMs(2, { baseMs: 10, capMs: 100_000, random: fixedRandom });
    const d3 = computeBackoffMs(3, { baseMs: 10, capMs: 100_000, random: fixedRandom });

    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
  });

  it("respects the cap for large attempt numbers", () => {
    const delay = computeBackoffMs(50, { baseMs: 100, capMs: 5_000, random: () => 1 });
    expect(delay).toBeLessThanOrEqual(5_000);
    expect(delay).toBe(5_000);
  });

  it("stays within [0, ceiling] jitter bounds for a range of attempts and random values", () => {
    const baseMs = 50;
    const capMs = 10_000;
    for (let attempt = 0; attempt < 10; attempt++) {
      const ceiling = Math.min(capMs, baseMs * 2 ** attempt);
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const delay = computeBackoffMs(attempt, { baseMs, capMs, random: () => r });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("uses default base/cap when options are omitted", () => {
    const delay = computeBackoffMs(0, { random: () => 1 });
    expect(delay).toBe(100); // default baseMs
  });

  it("treats a negative attempt as 0", () => {
    const delay = computeBackoffMs(-5, { baseMs: 100, capMs: 30_000, random: () => 1 });
    expect(delay).toBe(100);
  });

  it("clamps a random() value outside [0,1) defensively", () => {
    const overDelay = computeBackoffMs(0, { baseMs: 100, capMs: 30_000, random: () => 5 });
    expect(overDelay).toBe(100);

    const underDelay = computeBackoffMs(0, { baseMs: 100, capMs: 30_000, random: () => -5 });
    expect(underDelay).toBe(0);
  });

  it("never throws for extreme attempt values", () => {
    expect(() => computeBackoffMs(1000, { baseMs: 100, capMs: 30_000 })).not.toThrow();
  });
});

describe("retryWithBackoff", () => {
  it("returns the operation's result on first success without sleeping", async () => {
    const sleepCalls: number[] = [];
    const result = await retryWithBackoff(async () => "ok", {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(result).toBe("ok");
    expect(sleepCalls).toEqual([]);
  });

  it("invokes the injected sleep with the computed delay between retries", async () => {
    const sleepCalls: number[] = [];
    let attempts = 0;

    const result = await retryWithBackoff(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("transient");
        return "recovered";
      },
      {
        maxAttempts: 5,
        baseMs: 100,
        capMs: 30_000,
        random: () => 1,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      },
    );

    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
    // Two retries happened (after attempt 0 and attempt 1 failures).
    expect(sleepCalls).toEqual([100, 200]);
  });

  it("throws the last error after exhausting maxAttempts", async () => {
    const sleepCalls: number[] = [];
    let attempts = 0;

    await expect(
      retryWithBackoff(
        async () => {
          attempts++;
          throw new Error(`fail-${attempts}`);
        },
        {
          maxAttempts: 3,
          random: () => 0,
          sleep: async (ms) => {
            sleepCalls.push(ms);
          },
        },
      ),
    ).rejects.toThrow("fail-3");

    expect(attempts).toBe(3);
    // Sleeps only happen between attempts, not after the last one.
    expect(sleepCalls).toHaveLength(2);
  });

  it("does not retry and rethrows immediately when isRetryable returns false", async () => {
    const sleepCalls: number[] = [];
    let attempts = 0;

    await expect(
      retryWithBackoff(
        async () => {
          attempts++;
          throw new Error("logic error");
        },
        {
          maxAttempts: 5,
          isRetryable: () => false,
          sleep: async (ms) => {
            sleepCalls.push(ms);
          },
        },
      ),
    ).rejects.toThrow("logic error");

    expect(attempts).toBe(1);
    expect(sleepCalls).toEqual([]);
  });

  it("defaults maxAttempts to 3 when not provided", async () => {
    let attempts = 0;
    await expect(
      retryWithBackoff(
        async () => {
          attempts++;
          throw new Error("always fails");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("always fails");
    expect(attempts).toBe(3);
  });

  it("clamps maxAttempts to at least 1", async () => {
    let attempts = 0;
    await expect(
      retryWithBackoff(
        async () => {
          attempts++;
          throw new Error("fails");
        },
        { maxAttempts: 0, sleep: async () => {} },
      ),
    ).rejects.toThrow("fails");
    expect(attempts).toBe(1);
  });
});
