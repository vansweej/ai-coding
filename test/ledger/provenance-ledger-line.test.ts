import { describe, expect, it } from "bun:test";

import { progressEventToLedgerLine } from "../../src/ledger/ledger-writer";
import { parseLedgerLine } from "../../src/ledger/parse-ledger-line";

describe("progressEventToLedgerLine (provenance payload)", () => {
  it("a phase-finish event with a commitHash yields a line whose payload deep-equals { sha, commitMessage, runId }", () => {
    const runId = "run-test-abc123";
    const line = progressEventToLedgerLine(
      {
        kind: "phase-finish",
        phase: 1,
        commitHash: "abc123def456",
        commitMessage: "feat: add provenance",
      },
      runId,
    );

    expect(line.payload).toEqual({
      sha: "abc123def456",
      commitMessage: "feat: add provenance",
      runId,
    });
  });

  it("the produced line round-trips through parseLedgerLine, preserving a non-empty top-level runId", () => {
    const runId = "run-test-roundtrip";
    const line = progressEventToLedgerLine(
      {
        kind: "phase-finish",
        phase: 2,
        commitHash: "deadbeef",
        commitMessage: "feat: round trip",
      },
      runId,
    );

    const serialized = JSON.stringify(line);
    const parsed = parseLedgerLine(serialized);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.runId).toBe(runId);
      expect(parsed.value.runId.length).toBeGreaterThan(0);
    }
  });

  it("a phase-finish event with no commitHash yields a line with no payload", () => {
    const runId = "run-test-no-hash";
    const line = progressEventToLedgerLine(
      {
        kind: "phase-finish",
        phase: 3,
        commitMessage: "feat: no hash",
      },
      runId,
    );

    expect(line.payload).toBeUndefined();
  });

  it("a non-phase-finish event yields a line with no payload", () => {
    const runId = "run-test-non-finish";
    const line = progressEventToLedgerLine(
      {
        kind: "phase-start",
        phase: 1,
      },
      runId,
    );

    expect(line.payload).toBeUndefined();
  });
});
