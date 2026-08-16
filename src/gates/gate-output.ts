/**
 * GateOutput captures the full stdout, stderr, exit code, and correlation id
 * of a single gate execution (typecheck, lint, test, coverage, etc.).
 *
 * This replaces the truncated `Error.message` previously returned on failure;
 * full output is always preserved for ledger persistence and diagnostics.
 *
 * The optional `opId` links the gate back to the `LoweredPatchOp` that
 * triggered it, providing end-to-end op→gate correlation in the ledger.
 */
export interface GateOutput {
  /** Gate/step name (e.g. "typecheck", "test"). */
  readonly gate: string;
  /** Full captured stdout (not truncated). */
  readonly stdout: string;
  /** Full captured stderr (not truncated). */
  readonly stderr: string;
  /** Process exit code. */
  readonly exitCode: number;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Whether the gate passed (exitCode === 0). */
  readonly passed: boolean;
  /** Optional correlation id of the PatchOp that triggered this gate. */
  readonly opId?: string;
}

/**
 * Build a `GateOutput` from raw shell execution results.
 */
export function buildGateOutput(
  gate: string,
  stdout: string,
  stderr: string,
  exitCode: number,
  durationMs: number,
  opId?: string,
): GateOutput {
  return {
    gate,
    stdout,
    stderr,
    exitCode,
    durationMs,
    passed: exitCode === 0,
    ...(opId !== undefined ? { opId } : {}),
  };
}

/**
 * Build the `gate-output` ledger line payload from a `GateOutput`.
 */
export function gateOutputToLedgerPayload(go: GateOutput): Record<string, unknown> {
  return {
    gate: go.gate,
    exitCode: go.exitCode,
    passed: go.passed,
    stdout: go.stdout,
    stderr: go.stderr,
    durationMs: go.durationMs,
    ...(go.opId !== undefined ? { opId: go.opId } : {}),
  };
}
