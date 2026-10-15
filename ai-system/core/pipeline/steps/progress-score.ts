import type { VerificationFailure } from "./verification-failure";

/** A comparable score for a single failed verification attempt. */
export interface ProgressScore {
  readonly gateIndex: number;
  readonly gateSignature: string;
}

/** Derive a comparable ProgressScore from a classified verification failure. */
export function scoreFailure(failure: VerificationFailure): ProgressScore {
  return {
    gateIndex: failure.gateIndex,
    gateSignature: failure.gateNames.join(","),
  };
}

/**
 * Compare a known-best score against a candidate score by first-failing-gate
 * index. Differing gate lists are incomparable.
 */
export function compareProgress(
  best: ProgressScore,
  next: ProgressScore,
): "better" | "same" | "worse" | "incomparable" {
  if (best.gateSignature !== next.gateSignature) return "incomparable";
  if (next.gateIndex > best.gateIndex) return "better";
  if (next.gateIndex < best.gateIndex) return "worse";
  return "same";
}
