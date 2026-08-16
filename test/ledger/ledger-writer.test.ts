import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAbsolute } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createLedgerWriter, progressEventToLedgerLine } from "../../src/ledger/ledger-writer";
import { parseLedgerLine } from "../../src/ledger/parse-ledger-line";
import type { LedgerLine } from "../../src/ledger/parse-ledger-line";

// Override the home-dir-based path by monkey-patching — instead, write to a
// temp dir by constructing lines manually and writing to a tmp path directly.
// We test createLedgerWriter by using the real implementation but pointing it
// at a test-controlled runId so the path is predictable under ~/.local/share.

describe("createLedgerWriter", () => {
  const testRunId = `run-test-writer-${Date.now().toString(36)}`;
  let writerPath: string | undefined;

  afterEach(() => {
    if (writerPath) {
      try {
        rmSync(writerPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("returns ok and an absolute path", () => {
    const result = createLedgerWriter(testRunId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      writerPath = result.value.path;
      expect(isAbsolute(result.value.path)).toBe(true);
      expect(result.value.path).toContain(testRunId);
    }
  });

  it("writes lines that parse back via parseLedgerLine with the correct runId", () => {
    const result = createLedgerWriter(testRunId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const writer = result.value;
    writerPath = writer.path;

    const lines: LedgerLine[] = [
      {
        schema_version: 1,
        runId: testRunId,
        ts: "2026-08-16T12:00:00.000Z",
        kind: "phase-start",
        phase: 1,
      },
      {
        schema_version: 1,
        runId: testRunId,
        ts: "2026-08-16T12:00:01.000Z",
        kind: "step",
        phase: 1,
        step: 1,
      },
      {
        schema_version: 1,
        runId: testRunId,
        ts: "2026-08-16T12:00:02.000Z",
        kind: "phase-finish",
        phase: 1,
      },
    ];

    for (const line of lines) {
      const writeResult = writer.write(line);
      expect(writeResult.ok).toBe(true);
    }

    writer.close();

    const raw = readFileSync(writer.path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    expect(raw.length).toBe(3);
    for (const rawLine of raw) {
      const parsed = parseLedgerLine(rawLine);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.runId).toBe(testRunId);
      }
    }
  });
});

describe("progressEventToLedgerLine", () => {
  it("maps a phase-start event to a valid ledger line", () => {
    const runId = "run-test-map-001";
    const event = { kind: "phase-start", phase: 2 };
    const line = progressEventToLedgerLine(event, runId);

    expect(line.schema_version).toBe(1);
    expect(line.runId).toBe(runId);
    expect(line.kind).toBe("phase-start");
    expect(line.phase).toBe(2);
    expect(line.step).toBeUndefined();
    // ts should be a non-empty ISO string
    expect(line.ts.length).toBeGreaterThan(0);
  });

  it("maps a step event carrying both phase and step", () => {
    const runId = "run-test-map-002";
    const event = { kind: "step-finish", phase: 1, step: 3 };
    const line = progressEventToLedgerLine(event, runId);

    expect(line.phase).toBe(1);
    expect(line.step).toBe(3);
  });
});
