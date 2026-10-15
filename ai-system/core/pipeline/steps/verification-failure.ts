/**
 * Structured classification of a single failed verification gate.
 *
 * Verification gates run as an ordered list; the first failing gate stops the
 * list. This record captures which gate failed, its position, the full gate
 * list, and the parsed failure shape for downstream scoring.
 */
export interface VerificationFailure {
  readonly gate: string;
  readonly gateIndex: number;
  readonly totalGates: number;
  readonly gateNames: readonly string[];
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly message: string;
}

/**
 * Classify a verification failure from ordered gate names, its failed index,
 * and produced error. This pure helper never throws.
 */
export function classifyVerificationFailure(
  gateNames: readonly string[],
  gateIndex: number,
  error: Error,
): VerificationFailure {
  const message = error.message;
  const exitMatch = message.match(/(?:^| )exited with code (-?\d+)/);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : null;
  const timedOut = / timed out after \d+ms/.test(message);
  return {
    gate: gateNames[gateIndex] ?? "unknown",
    gateIndex,
    totalGates: gateNames.length,
    gateNames,
    exitCode,
    timedOut,
    message,
  };
}
