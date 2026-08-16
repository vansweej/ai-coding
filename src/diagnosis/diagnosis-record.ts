import type { LedgerLine } from "../ledger/parse-ledger-line";
import type { RunId } from "../run/run-id";

/**
 * DiagnosisRecord captures a single diagnostic finding surfaced during a
 * plan-cycle run -- e.g. an attributed root cause for a phase failure, or a
 * classification of a gate failure -- for ledger persistence and downstream
 * analysis.
 *
 * `phase`, `step`, and `opId` are optional correlation fields, mirroring the
 * same optional correlation contract used by `GateOutput` and `LedgerLine`.
 */
export interface DiagnosisRecord {
  /** Run correlation id (see run-id.ts). */
  readonly runId: RunId;
  /** ISO timestamp of when the diagnosis was made. */
  readonly ts: string;
  /** Short diagnosis category (e.g. "anchor-unexpandable", "apply-failed"). */
  readonly category: string;
  /** One-line human-readable summary. */
  readonly summary: string;
  /** Full diagnostic detail (may be multi-line). */
  readonly detail: string;
  /** Optional phase number this diagnosis pertains to. */
  readonly phase?: number;
  /** Optional step number this diagnosis pertains to. */
  readonly step?: number;
  /** Optional correlation id of the PatchOp this diagnosis pertains to. */
  readonly opId?: string;
}

/**
 * Construct a `DiagnosisRecord`, stamping `ts` with the current time.
 *
 * @param runId    - Run correlation id.
 * @param category - Short diagnosis category.
 * @param summary  - One-line human-readable summary.
 * @param detail   - Full diagnostic detail.
 * @param opts     - Optional phase/step/opId correlation fields.
 */
export function makeDiagnosis(
  runId: RunId,
  category: string,
  summary: string,
  detail: string,
  opts?: { readonly phase?: number; readonly step?: number; readonly opId?: string },
): DiagnosisRecord {
  return {
    runId,
    ts: new Date().toISOString(),
    category,
    summary,
    detail,
    ...(opts?.phase !== undefined ? { phase: opts.phase } : {}),
    ...(opts?.step !== undefined ? { step: opts.step } : {}),
    ...(opts?.opId !== undefined ? { opId: opts.opId } : {}),
  };
}

/**
 * Map a `DiagnosisRecord` to a `diagnosis` kind ledger line (schema_version 1),
 * matching the shape `createLedgerWriter`'s `write()` accepts.
 *
 * @param record - The diagnosis record to serialize.
 */
export function diagnosisToLedgerLine(record: DiagnosisRecord): LedgerLine {
  return {
    schema_version: 1,
    runId: record.runId,
    ts: record.ts,
    kind: "diagnosis",
    ...(record.phase !== undefined ? { phase: record.phase } : {}),
    ...(record.step !== undefined ? { step: record.step } : {}),
    ...(record.opId !== undefined ? { opId: record.opId } : {}),
    payload: {
      category: record.category,
      summary: record.summary,
      detail: record.detail,
    },
  };
}
