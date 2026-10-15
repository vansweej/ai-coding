import { describe, expect, it } from "bun:test";

import { classifyVerificationFailure } from "./verification-failure";

describe("classifyVerificationFailure", () => {
  const gateNames = ["typecheck", "test"];

  it("classifies an exited shell gate", () => {
    const result = classifyVerificationFailure(
      gateNames,
      0,
      new Error('Shell step "typecheck" exited with code 2: tsc failed'),
    );
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
    expect(result.gate).toBe("typecheck");
    expect(result.totalGates).toBe(2);
  });

  it("classifies a timed-out shell gate", () => {
    const result = classifyVerificationFailure(
      gateNames,
      1,
      new Error('Shell step "test" timed out after 5000ms'),
    );
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("uses unknown for an out-of-range gate", () => {
    expect(classifyVerificationFailure(gateNames, 3, new Error("failed")).gate).toBe("unknown");
  });

  it("parses a negative exit code", () => {
    expect(
      classifyVerificationFailure(gateNames, 0, new Error("exited with code -1")).exitCode,
    ).toBe(-1);
  });

  it("leaves unmatched error details unset", () => {
    const result = classifyVerificationFailure(gateNames, 0, new Error("failed"));
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
  });
});
