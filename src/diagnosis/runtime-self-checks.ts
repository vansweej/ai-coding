import type { LedgerWriter } from "../ledger/ledger-writer";
import { diagnosisToLedgerLine, makeDiagnosis } from "./diagnosis-record";
import type { RunId } from "../run/run-id";

/**
 * Cheap, load-bearing, read-only self-checks about the run's own health,
 * intended to run near run start / config assembly (spine-adjacent).
 *
 * Each check inspects a single invariant about the run's own state (never
 * about user code or workspace content) and, when violated, emits a
 * `diagnosis` ledger line via `makeDiagnosis`/`diagnosisToLedgerLine`
 * rather than throwing -- a self-check failure must never crash the run;
 * it is a diagnostic signal for later inspection.
 */

/** Minimal shape of run state these self-checks inspect. */
export interface RuntimeSelfCheckState {
  readonly runId: RunId;
  readonly ledgerPath: string;
  readonly eventStreamInitialized: boolean;
}

/**
 * Run every registered self-check against `state`, writing a `diagnosis`
 * ledger line via `ledger` for each violated invariant. Returns the list of
 * category strings that were violated (empty when the run is healthy).
 *
 * Never throws: `ledger.write` failures are swallowed defensively (a
 * self-check emitting a diagnosis must not itself crash the run).
 */
export function runRuntimeSelfChecks(
  state: RuntimeSelfCheckState,
  ledger: Pick<LedgerWriter, "write">,
): readonly string[] {
  const violated: string[] = [];

  function emit(category: string, summary: string, detail: string): void {
    violated.push(category);
    try {
      const record = makeDiagnosis(state.runId || "unknown-run-id", category, summary, detail);
      ledger.write(diagnosisToLedgerLine(record));
    } catch {
      // Never let a diagnostic emission failure crash the run.
    }
  }

  if (!state.runId || state.runId.trim() === "") {
    emit(
      "runId-missing",
      "Run id is missing or empty",
      "Expected a non-empty runId minted via mintRunId(); got an empty/undefined value.",
    );
  }

  if (!state.ledgerPath || !state.ledgerPath.startsWith("/")) {
    emit(
      "ledger-path-not-absolute",
      "Ledger writer path is not absolute",
      `Expected an absolute path for the ledger file; got "${state.ledgerPath}".`,
    );
  }

  if (!state.eventStreamInitialized) {
    emit(
      "event-stream-not-initialized",
      "Event stream not initialized",
      "Expected the event stream to be initialized before run start.",
    );
  }

  return violated;
}
