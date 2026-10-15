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
 * Absolute directory holding the per-run ledger files and their snapshots tree.
 *
 * Prefers `process.env.HOME` over `node:os`'s `homedir()` because Bun's
 * `homedir()` binding caches the home directory once at process startup and
 * does not observe later mutations to `process.env.HOME` -- a live JS
 * property read does. In normal operation `HOME` and `homedir()` agree;
 * this only matters for test isolation (overriding `HOME` in `beforeEach`
 * so ledger/snapshot writes never land under the real home directory).
 */
export function resolveLedgerDir(): string {
  return join(process.env.HOME ?? homedir(), ".local", "share", "ai-coding", "ledger");
}

/**
 * Resolve the per-run ledger path.
 * Location: `~/.local/share/ai-coding/ledger/<runId>.jsonl`
 */
function resolveLedgerPath(runId: RunId): string {
  return join(resolveLedgerDir(), `${runId}.jsonl`);
}

/**
 * Create a ledger writer for a single run.
 * Parent directories are created on first call. All appends are synchronous.
 */
export function createLedgerWriter(runId: RunId): Result<LedgerWriter> {
  const path = resolveLedgerPath(runId);
  try {
    mkdirSync(resolveLedgerDir(), { recursive: true });
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
export function progressEventToLedgerLine<
  E extends {
    readonly kind: string;
    readonly phase?: number;
    readonly step?: number;
    readonly commitHash?: string;
    readonly commitMessage?: string;
  },
>(event: E, runId: RunId): LedgerLine {
  if (event.kind === "phase-finish" && event.commitHash !== undefined) {
    return {
      schema_version: 1,
      runId,
      ts: new Date().toISOString(),
      kind: event.kind,
      ...(event.phase !== undefined ? { phase: event.phase } : {}),
      ...(event.step !== undefined ? { step: event.step } : {}),
      payload: {
        sha: event.commitHash,
        commitMessage: event.commitMessage,
        // Deliberate duplication -- see doc comment above.
        runId,
      },
    };
  }

  // `commitHash`/`commitMessage` are excluded from the generic "extra" bucket
  // below even when no payload was attached above (e.g. a `phase-finish`
  // event with no `commitHash`): those two fields are reserved for the
  // provenance payload shape and must never leak into another kind's
  // payload as an undocumented side effect of a missing `commitHash`.
  const { kind, phase, step, commitHash, commitMessage, ...rest } = event;
  const extra = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return {
    schema_version: 1,
    runId,
    ts: new Date().toISOString(),
    kind,
    ...(phase !== undefined ? { phase } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(Object.keys(extra).length > 0 ? { payload: extra } : {}),
  };
}
