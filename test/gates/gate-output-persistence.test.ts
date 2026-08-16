import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { buildGateOutput } from "../../src/gates/gate-output";
import { createLedgerWriter } from "../../src/ledger/ledger-writer";
import { parseLedgerLine } from "../../src/ledger/parse-ledger-line";
import { mintOpId } from "../../src/lower/event-types";
import { mintRunId } from "../../src/run/run-id";

describe("gate-output ledger persistence", () => {
  it("writes a gate-output line with full stdout and stderr (not truncated)", () => {
    const runId = mintRunId();
    const opId = mintOpId();
    const result = createLedgerWriter(runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const writer = result.value;
    const multiLineStdout = "line1\nline2\nline3\nline4\nline5";
    const multiLineStderr = "warn: something\nerr: something else\ndetail: more info";

    const go = buildGateOutput("typecheck", multiLineStdout, multiLineStderr, 1, 123, opId);
    const writeResult = writer.writeGateOutput(go, runId, 1);
    expect(writeResult.ok).toBe(true);
    writer.close();

    const raw = readFileSync(writer.path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    expect(raw.length).toBe(1);
    const parsed = parseLedgerLine(raw[0]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const line = parsed.value;
    expect(line.kind).toBe("gate-output");
    expect(line.opId).toBe(opId);
    expect(line.phase).toBe(1);

    // Full stdout and stderr must be present — not just Error.message
    expect(line.payload?.stdout).toBe(multiLineStdout);
    expect(line.payload?.stderr).toBe(multiLineStderr);
    expect(line.payload?.exitCode).toBe(1);
    expect(line.payload?.passed).toBe(false);
    expect(line.payload?.opId).toBe(opId);
  });

  it("passing gate yields passed:true in the ledger line", () => {
    const runId = mintRunId();
    const result = createLedgerWriter(runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const writer = result.value;
    const go = buildGateOutput("test", "all tests passed", "", 0, 50);
    writer.writeGateOutput(go, runId);
    writer.close();

    const raw = readFileSync(writer.path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    const parsed = parseLedgerLine(raw[0]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.payload?.passed).toBe(true);
    expect(parsed.value.payload?.exitCode).toBe(0);
    expect(parsed.value.payload?.stdout).toBe("all tests passed");
  });

  it("opId in ledger matches the triggering PatchOp opId", () => {
    const runId = mintRunId();
    const opId = mintOpId();
    const result = createLedgerWriter(runId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const writer = result.value;
    const go = buildGateOutput("lint", "", "lint error on line 5", 1, 200, opId);
    writer.writeGateOutput(go, runId, 2);
    writer.close();

    const raw = readFileSync(writer.path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    const parsed = parseLedgerLine(raw[0]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    // The correlation: ledger opId == the PatchOp's opId
    expect(parsed.value.opId).toBe(opId);
    expect(parsed.value.payload?.opId).toBe(opId);
    expect(parsed.value.payload?.stderr).toBe("lint error on line 5");
  });
});
