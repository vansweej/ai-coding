import { describe, expect, it } from "bun:test";

import { diagnosisToLedgerLine, makeDiagnosis } from "../../src/diagnosis/diagnosis-record";
import { parseLedgerLine } from "../../src/ledger/parse-ledger-line";

describe("DiagnosisRecord", () => {
  it("makeDiagnosis constructs a record with all required fields plus a ts stamp", () => {
    const record = makeDiagnosis("run-abc", "apply-failed", "anchor not found", "full detail here");
    expect(record.runId).toBe("run-abc");
    expect(record.category).toBe("apply-failed");
    expect(record.summary).toBe("anchor not found");
    expect(record.detail).toBe("full detail here");
    expect(typeof record.ts).toBe("string");
    expect(record.ts.length).toBeGreaterThan(0);
    expect(record.phase).toBeUndefined();
    expect(record.step).toBeUndefined();
    expect(record.opId).toBeUndefined();
  });

  it("makeDiagnosis includes optional phase/step/opId when provided", () => {
    const record = makeDiagnosis("run-abc", "cat", "sum", "det", {
      phase: 3,
      step: 2,
      opId: "op-123",
    });
    expect(record.phase).toBe(3);
    expect(record.step).toBe(2);
    expect(record.opId).toBe("op-123");
  });

  it("round-trips a full record through diagnosisToLedgerLine and parseLedgerLine", () => {
    const record = makeDiagnosis("run-xyz", "conversion-failed", "summary text", "detail text", {
      phase: 5,
      step: 1,
      opId: "op-789",
    });

    const line = diagnosisToLedgerLine(record);
    const serialized = JSON.stringify(line);
    const parsed = parseLedgerLine(serialized);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.schema_version).toBe(1);
    expect(parsed.value.runId).toBe("run-xyz");
    expect(parsed.value.ts).toBe(record.ts);
    expect(parsed.value.kind).toBe("diagnosis");
    expect(parsed.value.phase).toBe(5);
    expect(parsed.value.step).toBe(1);
    expect(parsed.value.opId).toBe("op-789");
    expect(parsed.value.payload).toEqual({
      category: "conversion-failed",
      summary: "summary text",
      detail: "detail text",
    });
  });

  it("round-trips a minimal record (no phase/step/opId) through the ledger line format", () => {
    const record = makeDiagnosis("run-min", "noNetChange", "no changes", "nothing was written");

    const line = diagnosisToLedgerLine(record);
    const serialized = JSON.stringify(line);
    const parsed = parseLedgerLine(serialized);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.runId).toBe("run-min");
    expect(parsed.value.kind).toBe("diagnosis");
    expect(parsed.value.phase).toBeUndefined();
    expect(parsed.value.step).toBeUndefined();
    expect(parsed.value.opId).toBeUndefined();
    expect(parsed.value.payload).toEqual({
      category: "noNetChange",
      summary: "no changes",
      detail: "nothing was written",
    });
  });
});
