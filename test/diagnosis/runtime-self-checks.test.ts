import { describe, expect, it } from "bun:test";

import type { LedgerLine } from "../../src/ledger/parse-ledger-line";
import { runRuntimeSelfChecks } from "../../src/diagnosis/runtime-self-checks";

function makeRecordingLedger(): { lines: LedgerLine[]; write: (line: LedgerLine) => { ok: true; value: undefined } } {
  const lines: LedgerLine[] = [];
  return {
    lines,
    write: (line: LedgerLine) => {
      lines.push(line);
      return { ok: true, value: undefined };
    },
  };
}

describe("runRuntimeSelfChecks", () => {
  it("emits a diagnosis ledger line with category runId-missing when runId is empty", () => {
    const ledger = makeRecordingLedger();

    const violated = runRuntimeSelfChecks(
      { runId: "", ledgerPath: "/home/user/.local/share/ai-coding/ledger/run-1.jsonl", eventStreamInitialized: true },
      ledger,
    );

    expect(violated).toContain("runId-missing");
    expect(ledger.lines).toHaveLength(1);
    expect(ledger.lines[0]?.kind).toBe("diagnosis");
    expect(ledger.lines[0]?.payload?.category).toBe("runId-missing");
  });

  it("emits a diagnosis ledger line with category ledger-path-not-absolute when the path is relative", () => {
    const ledger = makeRecordingLedger();

    const violated = runRuntimeSelfChecks(
      { runId: "run-abc-123", ledgerPath: "relative/path.jsonl", eventStreamInitialized: true },
      ledger,
    );

    expect(violated).toContain("ledger-path-not-absolute");
    expect(ledger.lines.some((l) => l.payload?.category === "ledger-path-not-absolute")).toBe(true);
  });

  it("emits a diagnosis ledger line with category event-stream-not-initialized when false", () => {
    const ledger = makeRecordingLedger();

    const violated = runRuntimeSelfChecks(
      { runId: "run-abc-123", ledgerPath: "/abs/path.jsonl", eventStreamInitialized: false },
      ledger,
    );

    expect(violated).toContain("event-stream-not-initialized");
  });

  it("emits no diagnosis lines for a healthy run", () => {
    const ledger = makeRecordingLedger();

    const violated = runRuntimeSelfChecks(
      { runId: "run-abc-123", ledgerPath: "/abs/path.jsonl", eventStreamInitialized: true },
      ledger,
    );

    expect(violated).toEqual([]);
    expect(ledger.lines).toHaveLength(0);
  });

  it("emits multiple diagnosis lines when multiple invariants are violated", () => {
    const ledger = makeRecordingLedger();

    const violated = runRuntimeSelfChecks(
      { runId: "", ledgerPath: "relative.jsonl", eventStreamInitialized: false },
      ledger,
    );

    expect(violated).toHaveLength(3);
    expect(ledger.lines).toHaveLength(3);
  });
});
