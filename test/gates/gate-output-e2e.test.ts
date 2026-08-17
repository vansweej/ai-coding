import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";

import { createShellStep } from "../../packages/pipeline/src/steps/shell-step";
import { buildGateOutput } from "../../src/gates/gate-output";
import { type LedgerWriter, createLedgerWriter } from "../../src/ledger/ledger-writer";
import { parseLedgerLine } from "../../src/ledger/parse-ledger-line";
import { mintRunId } from "../../src/run/run-id";

/**
 * End-to-end proof that the `onGateOutput` seam (wired in
 * `packages/pipeline/src/steps/shell-step.ts`) actually results in real,
 * non-synthetic gate stdout/stderr/exitCode/duration being persisted to the
 * ledger -- closing the gap where `gate-output-persistence.test.ts` only
 * ever exercised `writeGateOutput` directly with hand-built `GateOutput`
 * fixtures, never a REAL step execution. Uses `createShellStep` directly
 * (option (a) from the plan) since that is sufficient to prove the wiring
 * without re-testing shell-step's own unit behavior or standing up a full
 * `runVerification`/`createVerifiedImplementStep` phase.
 *
 * Writes to the real default ledger path (`createLedgerWriter` has no
 * path-override seam -- confirmed by inspecting `resolveLedgerPath`, which
 * is private and always resolves under `~/.local/share/ai-coding/ledger/`)
 * and removes the file in `afterEach`.
 */
describe("gate-output end-to-end persistence", () => {
  let writer: LedgerWriter | undefined;

  afterEach(() => {
    if (writer) {
      rmSync(writer.path, { force: true });
      writer = undefined;
    }
  });

  it("persists real gate stdout/stderr/exitCode from a passing and a failing shell step, with no opId", async () => {
    const runId = mintRunId();
    const ledgerResult = createLedgerWriter(runId);
    expect(ledgerResult.ok).toBe(true);
    if (!ledgerResult.ok) return;
    writer = ledgerResult.value;
    const ledger = writer;

    const onGateOutput = (
      name: string,
      stdout: string,
      stderr: string,
      exitCode: number,
      durationMs: number,
    ): void => {
      const go = buildGateOutput(name, stdout, stderr, exitCode, durationMs);
      ledger.writeGateOutput(go, runId, 1);
    };

    const passingStep = createShellStep("real-pass", ["true"], { onGateOutput });
    const passResult = await passingStep.execute({ event: undefined, results: new Map() } as never);
    expect(passResult.ok).toBe(true);

    const failingStep = createShellStep(
      "real-fail",
      ["sh", "-c", "echo boom-stdout; echo boom-stderr >&2; exit 1"],
      { onGateOutput, failOnNonZero: false },
    );
    const failResult = await failingStep.execute({ event: undefined, results: new Map() } as never);
    expect(failResult.ok).toBe(true);

    ledger.close();

    const lines = readFileSync(ledger.path, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const parsed = parseLedgerLine(l);
        expect(parsed.ok).toBe(true);
        return parsed.ok ? parsed.value : null;
      });

    expect(lines.length).toBe(2);

    const passLine = lines.find((l) => l?.payload?.gate === "real-pass");
    const failLine = lines.find((l) => l?.payload?.gate === "real-fail");

    expect(passLine).toBeDefined();
    expect(passLine?.kind).toBe("gate-output");
    expect(passLine?.runId).toBe(runId);
    expect(passLine?.phase).toBe(1);
    expect(passLine?.payload?.exitCode).toBe(0);
    expect(passLine?.payload?.passed).toBe(true);
    expect(passLine?.opId).toBeUndefined();
    expect(passLine?.payload?.opId).toBeUndefined();

    expect(failLine).toBeDefined();
    expect(failLine?.kind).toBe("gate-output");
    expect(failLine?.runId).toBe(runId);
    expect(failLine?.phase).toBe(1);
    expect(failLine?.payload?.exitCode).toBe(1);
    expect(failLine?.payload?.passed).toBe(false);
    expect(failLine?.payload?.stdout).toContain("boom-stdout");
    expect(failLine?.payload?.stderr).toContain("boom-stderr");
    expect(failLine?.opId).toBeUndefined();
    expect(failLine?.payload?.opId).toBeUndefined();
  });
});
