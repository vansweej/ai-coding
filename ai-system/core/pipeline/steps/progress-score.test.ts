import { describe, expect, it } from "bun:test";

import { compareProgress, scoreFailure } from "./progress-score";
import type { VerificationFailure } from "./verification-failure";

function failure(overrides: Partial<VerificationFailure> = {}): VerificationFailure {
  return {
    gate: "typecheck",
    gateIndex: 0,
    totalGates: 2,
    gateNames: ["typecheck", "test"],
    exitCode: 1,
    timedOut: false,
    message: "failed",
    ...overrides,
  };
}

describe("progress-score (first-failing-gate index ranking)", () => {
  it("copies the gate index and joins gate names", () => {
    const result = scoreFailure(failure({ gateIndex: 1 }));
    expect(result.gateIndex).toBe(1);
    expect(result.gateSignature).toBe("typecheck,test");
  });

  it("marks differing gate lists incomparable", () => {
    expect(
      compareProgress({ gateIndex: 0, gateSignature: "a" }, { gateIndex: 1, gateSignature: "b" }),
    ).toBe("incomparable");
  });

  it("identifies progress through more gates as better", () => {
    expect(
      compareProgress({ gateIndex: 0, gateSignature: "a" }, { gateIndex: 1, gateSignature: "a" }),
    ).toBe("better");
  });

  it("identifies earlier failures as worse", () => {
    expect(
      compareProgress({ gateIndex: 1, gateSignature: "a" }, { gateIndex: 0, gateSignature: "a" }),
    ).toBe("worse");
  });

  it("identifies equal failure gates as the same", () => {
    expect(
      compareProgress({ gateIndex: 1, gateSignature: "a" }, { gateIndex: 1, gateSignature: "a" }),
    ).toBe("same");
  });
});
