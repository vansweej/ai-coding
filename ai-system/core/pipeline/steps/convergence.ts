import type { VerificationFailure } from "./verification-failure";

/**
 * Produce a stable fingerprint for a verification failure. Volatile details
 * are normalized while stable diagnostic identity remains intact.
 */
export function fingerprintFailure(failure: VerificationFailure): string {
  const raw = `${failure.gate}|${failure.exitCode ?? "none"}|${failure.message}`;
  return raw
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>")
    .replace(/:\d+:\d+/g, ":<pos>")
    .replace(/:\d+/g, ":<line>")
    .replace(/\b\d+(?:\.\d+)?m?s\b/g, "<dur>")
    .replace(/(?<![:/\w.-])\/(?:[\w.-]+\/)*[\w.-]+/g, "<path>")
    .replace(/\b[0-9a-f]{7,}\b/g, "<hash>")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether two consecutive, non-empty failure fingerprints are identical. */
export function hasConverged(previous: string | undefined, current: string): boolean {
  return previous !== undefined && previous === current && current.length > 0;
}
