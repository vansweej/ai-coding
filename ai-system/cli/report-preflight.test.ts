import { describe, expect, it } from "bun:test";

import type { PreflightReport } from "../core/pipeline/preflight";
import { reportPreflight } from "./report-preflight";

const REPORT: PreflightReport = {
  violations: [
    { rule: "assert-path-missing", severity: "error", phase: 1, message: "missing path" },
    { rule: "step-without-edit-target", severity: "warn", phase: 2, message: "vague step" },
  ],
};

describe("reportPreflight", () => {
  it("renders error and warn lines with the PREFLIGHT prefix", () => {
    const result = reportPreflight(REPORT, false);
    expect(result.lines[0]).toBe("PREFLIGHT ERROR: [assert-path-missing] missing path");
    expect(result.lines[1]).toBe("PREFLIGHT WARN: [step-without-edit-target] vague step");
  });

  it("counts one error and one warning and aborts in non-strict mode", () => {
    const result = reportPreflight(REPORT, false);
    expect(result.errorCount).toBe(1);
    expect(result.warnCount).toBe(1);
    expect(result.abort).toBe(true);
  });

  it("promotes warnings to errors under strict mode", () => {
    const warnOnly: PreflightReport = {
      violations: [
        { rule: "step-without-edit-target", severity: "warn", phase: 1, message: "vague" },
      ],
    };
    const lenient = reportPreflight(warnOnly, false);
    expect(lenient.abort).toBe(false);
    const strict = reportPreflight(warnOnly, true);
    expect(strict.errorCount).toBe(1);
    expect(strict.abort).toBe(true);
    expect(strict.lines[0]).toContain("PREFLIGHT ERROR:");
  });

  it("returns no lines and does not abort for an empty report", () => {
    const result = reportPreflight({ violations: [] }, true);
    expect(result.lines.length).toBe(0);
    expect(result.abort).toBe(false);
  });
});
