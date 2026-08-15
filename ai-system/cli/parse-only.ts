import type { Result } from "@ai-coding/pipeline";

/** Output of {@link reportParseOnly}: a formatted string and a process exit code. */
export interface ParseOnlyReport {
  readonly output: string;
  readonly exitCode: number;
}

/**
 * Pure formatting helper for parse-only results.
 *
 * Converts a `Result` (success or failure) from a plan-file parse attempt
 * into a human-readable `output` string and a numeric `exitCode`, with no
 * I/O side effects. Callers are responsible for writing `output` and
 * calling `process.exit(exitCode)`.
 *
 * @param result - The parse result to format.
 * @returns A `{ output, exitCode }` record: exit 0 on success, non-zero on failure.
 */
export function reportParseOnly(result: Result<unknown>): ParseOnlyReport {
  if (result.ok) {
    return {
      output: "Parse succeeded.",
      exitCode: 0,
    };
  }
  return {
    output: `Parse failed: ${result.error.message}`,
    exitCode: 1,
  };
}
