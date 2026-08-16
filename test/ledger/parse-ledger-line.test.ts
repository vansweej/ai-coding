import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLedgerLine } from "../../src/ledger/parse-ledger-line";

const GOLDEN_PATH = join(import.meta.dir, "../fixtures/ledger/golden-v1.jsonl");

describe("parseLedgerLine – golden-v1 forward-accept", () => {
  it("parses every line in golden-v1.jsonl without error", () => {
    const lines = readFileSync(GOLDEN_PATH, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const result = parseLedgerLine(line);
      expect(result.ok).toBe(true);
    }
  });

  it("accepts an unknown kind value (forward-compat)", () => {
    const line = JSON.stringify({
      schema_version: 1,
      runId: "run-fwd-001",
      ts: "2030-01-01T00:00:00.000Z",
      kind: "some-future-kind-unknown-to-v1",
      payload: { futureField: 42, anotherField: "hello" },
    });

    const result = parseLedgerLine(line);
    expect(result.ok).toBe(true);
  });

  it("accepts unknown payload fields on a known kind (forward-compat)", () => {
    const line = JSON.stringify({
      schema_version: 1,
      runId: "run-fwd-002",
      ts: "2030-01-01T00:00:00.000Z",
      kind: "step",
      phase: 1,
      step: 1,
      payload: { status: "ok", attempt: 1, unknownFutureField: true, anotherUnknown: [1, 2, 3] },
    });

    const result = parseLedgerLine(line);
    expect(result.ok).toBe(true);
  });
});

describe("parseLedgerLine – malformed lines", () => {
  it("returns err when runId is missing", () => {
    const line = JSON.stringify({
      schema_version: 1,
      ts: "2026-08-16T12:00:00.000Z",
      kind: "step",
    });

    const result = parseLedgerLine(line);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("runId");
    }
  });

  it("returns err for invalid JSON", () => {
    const result = parseLedgerLine("not-json{{{");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("invalid JSON");
    }
  });

  it("returns err when schema_version is missing", () => {
    const line = JSON.stringify({
      runId: "run-x",
      ts: "2026-08-16T12:00:00.000Z",
      kind: "step",
    });
    const result = parseLedgerLine(line);
    expect(result.ok).toBe(false);
  });

  it("returns err when schema_version is not a positive integer", () => {
    const line = JSON.stringify({
      schema_version: 0,
      runId: "run-x",
      ts: "2026-08-16T12:00:00.000Z",
      kind: "step",
    });
    const result = parseLedgerLine(line);
    expect(result.ok).toBe(false);
  });

  it("returns err when line is a JSON array", () => {
    const result = parseLedgerLine("[1,2,3]");
    expect(result.ok).toBe(false);
  });
});
