import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { GateOutput } from "../gates/gate-output";
import type { RunId } from "../run/run-id";
import type { LedgerLine } from "./parse-ledger-line";

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Known ledger line kinds (extensible — unknown kinds are accepted by the parser).
 * Callers use these string literals directly; this list is informational.
 *
 * phase-start | step | gate-output | degraded-exit | vacuous-pass | diagnosis | run-shape
 */

export interface LedgerWriter {
  /** Absolute path to the JSON-lines ledger file. */
  readonly path: string;
  /** Append one ledger line. Returns err on IO failure. */
  write(line: LedgerLine): Result<void>;
  /** Write a gate-output kind ledger line from a GateOutput record. */
  writeGateOutput(go: GateOutput, runId: RunId, phase?: number): Result<void>;
  /** No-op — included for symmetry and future buffered implementations. */
  close(): void;
}

/**
 * Resolve the per-run ledger path.
 * Location: `~/.local/share/ai-coding/ledger/<runId>.jsonl`
 */
function resolveLedgerPath(runId: RunId): string {
  return join(homedir(), ".local", "share", "ai-coding", "ledger", `${runId}.jsonl`);
}

/**
 * Create a ledger writer for a single run.
 * Parent directories are created on first call. All appends are synchronous.
 */
export function createLedgerWriter(runId: RunId): Result<LedgerWriter> {
  const path = resolveLedgerPath(runId);
  try {
    mkdirSync(join(homedir(), ".local", "share", "ai-coding", "ledger"), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  function append(line: LedgerLine): Result<void> {
    try {
      appendFileSync(path, `${JSON.stringify(line)}\n`, "utf-8");
      return { ok: true, value: undefined };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
  }

  const writer: LedgerWriter = {
    path,
    write(line: LedgerLine): Result<void> {
      return append(line);
    },
    writeGateOutput(go: GateOutput, rid: RunId, phase?: number): Result<void> {
      const line: LedgerLine = {
        schema_version: 1,
        runId: rid,
        ts: new Date().toISOString(),
        kind: "gate-output",
        ...(phase !== undefined ? { phase } : {}),
        ...(go.opId !== undefined ? { opId: go.opId } : {}),
        payload: {
          gate: go.gate,
          exitCode: go.exitCode,
          passed: go.passed,
          stdout: go.stdout,
          stderr: go.stderr,
          durationMs: go.durationMs,
          ...(go.opId !== undefined ? { opId: go.opId } : {}),
        },
      };
      return append(line);
    },
    close() {
      // no-op for synchronous append-based implementation
    },
  };

  return { ok: true, value: writer };
}

/**
 * Map a ProgressEvent kind to a ledger line kind.
 * Phase/step numbers are extracted from the event when present.
 *
 * For a `phase-finish` event carrying a `commitHash`, a provenance
 * `payload` is attached: `{ sha, commitMessage, runId }`. Note that
 * duplicating `runId` inside this payload alongside the REQUIRED top-level
 * `LedgerLine.runId` is DELIBERATE -- so an extracted standalone provenance
 * payload (e.g. copied out of the ledger file for external consumption) is
 * self-contained. Do not "dedupe" this field.
 */
export function progressEventToLedgerLine(
  event: {
    kind: string;
    phase?: number;
    step?: number;
    commitHash?: string;
    commitMessage?: string;
  },
  runId: RunId,
): LedgerLine {
  return {
    schema_version: 1,
    runId,
    ts: new Date().toISOString(),
    kind: event.kind,
    ...(event.phase !== undefined ? { phase: event.phase } : {}),
    ...(event.step !== undefined ? { step: event.step } : {}),
    ...(event.kind === "phase-finish" && event.commitHash !== undefined
      ? {
          payload: {
            sha: event.commitHash,
            commitMessage: event.commitMessage,
            // Deliberate duplication -- see doc comment above.
            runId,
          },
        }
      : {}),
  };
}
