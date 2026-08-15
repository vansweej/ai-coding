import { describe, expect, it } from "bun:test";
import { reportParseOnly } from "./parse-only";

describe("reportParseOnly", () => {
  it("returns exitCode 0 and success output on an ok result", () => {
    const report = reportParseOnly({ ok: true, value: { phases: [] } });
    expect(report.exitCode).toBe(0);
    expect(report.output).toContain("succeeded");
  });

  it("returns non-zero exitCode and failure output on an error result", () => {
    const report = reportParseOnly({
      ok: false,
      error: new Error("missing # Feature: heading"),
    });
    expect(report.exitCode).not.toBe(0);
    expect(report.output).toContain("missing # Feature: heading");
  });
});
