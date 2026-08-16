/**
 * Utilities for diagnosing patch-parse failures by bounding raw payloads.
 */

/**
 * Return at most `maxLen` characters of `raw`, truncating with an ellipsis
 * if the string exceeds that length. Pure function; no side-effects.
 *
 * @param raw    - The raw string to bound.
 * @param maxLen - Maximum number of characters to return. Defaults to 2000.
 * @returns The (possibly truncated) string.
 */
export function boundedPayload(raw: string, maxLen = 2000): string {
  if (raw.length <= maxLen) return raw;
  return `${raw.slice(0, maxLen)}…`;
}
