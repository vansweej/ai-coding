export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export interface LedgerLine {
  readonly schema_version: number;
  readonly runId: string;
  readonly ts: string;
  readonly kind: string;
  readonly phase?: number;
  readonly step?: number;
  readonly opId?: string;
  readonly payload?: Record<string, unknown>;
}

export interface LedgerParseError {
  readonly reason: string;
  readonly raw: string;
}

export function parseLedgerLine(line: string): Result<LedgerLine, LedgerParseError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, error: { reason: "invalid JSON", raw: line } };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: { reason: "line is not a JSON object", raw: line } };
  }

  const obj = parsed as Record<string, unknown>;

  if (
    typeof obj.schema_version !== "number" ||
    !Number.isInteger(obj.schema_version) ||
    obj.schema_version < 1
  ) {
    return {
      ok: false,
      error: { reason: "schema_version must be a positive integer", raw: line },
    };
  }

  if (typeof obj.runId !== "string" || obj.runId.length === 0) {
    return { ok: false, error: { reason: "runId must be a non-empty string", raw: line } };
  }

  if (typeof obj.ts !== "string" || obj.ts.length === 0) {
    return { ok: false, error: { reason: "ts must be a non-empty string", raw: line } };
  }

  if (typeof obj.kind !== "string" || obj.kind.length === 0) {
    return { ok: false, error: { reason: "kind must be a non-empty string", raw: line } };
  }

  const ledgerLine: LedgerLine = {
    schema_version: obj.schema_version,
    runId: obj.runId,
    ts: obj.ts,
    kind: obj.kind,
    ...(typeof obj.phase === "number" ? { phase: obj.phase } : {}),
    ...(typeof obj.step === "number" ? { step: obj.step } : {}),
    ...(typeof obj.opId === "string" ? { opId: obj.opId } : {}),
    ...(typeof obj.payload === "object" && obj.payload !== null && !Array.isArray(obj.payload)
      ? { payload: obj.payload as Record<string, unknown> }
      : {}),
  };

  return { ok: true, value: ledgerLine };
}
