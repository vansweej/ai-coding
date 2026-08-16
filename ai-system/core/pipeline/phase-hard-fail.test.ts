import { describe, expect, it } from "bun:test";

import { PHASE_FAILURE_REASONS, phaseHardFail } from "./phase-hard-fail";

describe("phaseHardFail", () => {
  it("returns ok: false", () => {
    const result = phaseHardFail(3, PHASE_FAILURE_REASONS.noNetChange, "no textual diff");
    expect(result.ok).toBe(false);
  });

  it("error.name is PhaseHardFailError", () => {
    const result = phaseHardFail(3, PHASE_FAILURE_REASONS.noNetChange, "no textual diff");
    if (!result.ok) {
      expect(result.error.name).toBe("PhaseHardFailError");
    }
  });

  it("message equals 'Phase 3 hard-fail [noNetChange]: no textual diff'", () => {
    const result = phaseHardFail(3, PHASE_FAILURE_REASONS.noNetChange, "no textual diff");
    if (!result.ok) {
      expect(result.error.message).toBe("Phase 3 hard-fail [noNetChange]: no textual diff");
    }
  });

  it("structuralAssertion round-trips", () => {
    const result = phaseHardFail(
      7,
      PHASE_FAILURE_REASONS.structuralAssertion,
      "file does not contain expected needle",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("PhaseHardFailError");
      expect(result.error.message).toBe(
        "Phase 7 hard-fail [structuralAssertion]: file does not contain expected needle",
      );
    }
  });
});
