import { describe, expect, it } from "bun:test";

import { fingerprintFailure, hasConverged } from "./convergence";
import type { VerificationFailure } from "./verification-failure";

function failure(message: string): VerificationFailure {
  return {
    gate: "verify",
    gateIndex: 0,
    totalGates: 1,
    gateNames: ["verify"],
    exitCode: 2,
    timedOut: false,
    message,
  };
}

describe("fingerprintFailure", () => {
  it("normalizes ISO timestamps", () => {
    expect(fingerprintFailure(failure("at 2026-10-15T10:00:00Z"))).toBe(
      fingerprintFailure(failure("at 2026-11-16T11:01:02Z")),
    );
  });

  it("normalizes source positions", () => {
    expect(fingerprintFailure(failure("src/a.ts:10:20 failed"))).toBe(
      fingerprintFailure(failure("src/a.ts:30:40 failed")),
    );
  });

  it("normalizes durations", () => {
    expect(fingerprintFailure(failure("failed after 123ms"))).toBe(
      fingerprintFailure(failure("failed after 456ms")),
    );
  });

  it("normalizes paths without consuming URL schemes or comments", () => {
    const result = fingerprintFailure(
      failure("/home/user/src/index.ts https://example.com/x // comment"),
    );
    expect(result).toContain("<path>");
    expect(result).toContain("https:");
    expect(result).toContain("comment");
  });

  it("preserves bare trailing counters", () => {
    expect(fingerprintFailure(failure("compile error 1"))).not.toBe(
      fingerprintFailure(failure("compile error 2")),
    );
  });

  it("preserves diagnostic identities", () => {
    const result = fingerprintFailure(failure("TS2345 clippy::needless_return"));
    expect(result).toContain("TS2345");
    expect(result).toContain("clippy::needless_return");
  });

  it("does not normalize HTTP schemes", () => {
    expect(fingerprintFailure(failure("http://localhost:8080/x"))).toContain("http:");
  });

  it("normalizes differing absolute paths", () => {
    expect(fingerprintFailure(failure("/tmp/a/b.ts failed"))).toBe(
      fingerprintFailure(failure("/tmp/c/d.ts failed")),
    );
  });
});

describe("hasConverged", () => {
  it("requires identical non-empty consecutive fingerprints", () => {
    expect(hasConverged(undefined, "x")).toBe(false);
    expect(hasConverged("x", "x")).toBe(true);
    expect(hasConverged("", "")).toBe(false);
  });
});
