/** Default maximum output tokens for implement/fix attempts. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** Environment variable name overriding the default output-token budget. */
export const MAX_OUTPUT_TOKENS_ENV = "AI_CODING_MAX_OUTPUT_TOKENS";

/**
 * Resolve the maximum output-token budget for an implement/fix attempt.
 *
 * Reads {@link MAX_OUTPUT_TOKENS_ENV} from the supplied environment. A valid
 * positive integer wins; anything else (missing, zero, negative, fractional,
 * non-numeric) falls back to {@link DEFAULT_MAX_OUTPUT_TOKENS}. Pure: all input
 * is passed in, nothing is read from the ambient process.
 */
export function resolveMaxOutputTokens(env: Record<string, string | undefined>): number {
  const raw = env[MAX_OUTPUT_TOKENS_ENV];
  if (raw === undefined) return DEFAULT_MAX_OUTPUT_TOKENS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_MAX_OUTPUT_TOKENS;
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_MAX_OUTPUT_TOKENS;
  return value;
}
