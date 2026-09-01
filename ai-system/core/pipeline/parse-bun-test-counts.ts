import type { Result } from "@ai-coding/pipeline";

/**
 * Structured counts extracted from a `bun test` invocation's combined
 * stdout+stderr output blob.
 *
 * Bun writes stdout and stderr concatenated into one blob when captured
 * non-interactively (e.g. `bun test <file> 2>&1`), so per-test title lines
 * (`(pass) suite > case`), assertion-diff code frames, and the final
 * summary counters all live in the same string being scanned. Every counter
 * field here is parsed from a REAL summary line (e.g. " 1 pass") anchored
 * to the full line via the `m` flag and horizontal-whitespace-only classes
 * (`[ \t]`, never `\s`, which would also match newlines) -- this prevents
 * counter-like substrings embedded in test titles or diff output (e.g.
 * "(pass) suite > 1 fail path" or a code frame "3 | expect(x).toBe(1)")
 * from corrupting the real counts.
 *
 * The ANSI escape strip (`/\x1b\[[0-9;]*m/g`) applied before parsing is
 * defence-in-depth only: the real piped non-TTY capture this module targets
 * contains no colour codes, but a `FORCE_COLOR` environment variable could
 * reintroduce them, so stripping first keeps the anchored regexes robust
 * against that possibility.
 */
export interface BunTestCounts {
  /** True iff at least one recognized summary token was matched anywhere in the output. */
  readonly parsed: boolean;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly todo: number;
  /** Always `passed + failed` -- never derived from the `Ran ... tests` total (see D1). */
  readonly executed: number;
  /** Number of files Bun reports having run, from the `Ran ... across N files` line. */
  readonly filesRan: number;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape strip is intentional
const ANSI_STRIP_RE = /\x1b\[[0-9;]*m/g;

const PASSED_RE = /^[ \t]*(\d+)[ \t]+pass[ \t]*$/m;
const FAILED_RE = /^[ \t]*(\d+)[ \t]+fail[ \t]*$/m;
const SKIPPED_RE = /^[ \t]*(\d+)[ \t]+skip[ \t]*$/m;
const TODO_RE = /^[ \t]*(\d+)[ \t]+todo[ \t]*$/m;
/** Informational only -- never feeds `executed` (see D1); stays unanchored/case-insensitive. */
const RAN_RE = /Ran\s+(\d+)\s+tests?\s+across\s+(\d+)\s+files?/i;

/**
 * Parse a `bun test` combined stdout+stderr output blob into structured
 * counts.
 *
 * Fail-closed by construction: `parsed` is `true` only when at least one
 * recognized summary token (pass/fail/skip/todo counter lines, or the
 * `Ran ... tests across ... files` line) was actually matched; any missing
 * individual counter defaults to `0`. **D1:** `executed` is ALWAYS
 * `passed + failed` -- the `Ran` line's total includes skipped/todo tests
 * and therefore must never feed `executed` directly (a skip-only or
 * todo-only file would otherwise be miscounted as having executed tests).
 *
 * @param output - The raw combined stdout+stderr blob from a `bun test` run.
 */
export function parseBunTestCounts(output: string): BunTestCounts {
  const cleaned = output.replace(ANSI_STRIP_RE, "");

  const passedMatch = PASSED_RE.exec(cleaned);
  const failedMatch = FAILED_RE.exec(cleaned);
  const skippedMatch = SKIPPED_RE.exec(cleaned);
  const todoMatch = TODO_RE.exec(cleaned);
  const ranMatch = RAN_RE.exec(cleaned);

  const passed = passedMatch ? Number.parseInt(passedMatch[1], 10) : 0;
  const failed = failedMatch ? Number.parseInt(failedMatch[1], 10) : 0;
  const skipped = skippedMatch ? Number.parseInt(skippedMatch[1], 10) : 0;
  const todo = todoMatch ? Number.parseInt(todoMatch[1], 10) : 0;
  const filesRan = ranMatch ? Number.parseInt(ranMatch[2], 10) : 0;

  const parsed =
    passedMatch !== null ||
    failedMatch !== null ||
    skippedMatch !== null ||
    todoMatch !== null ||
    ranMatch !== null;

  return {
    parsed,
    passed,
    failed,
    skipped,
    todo,
    executed: passed + failed,
    filesRan,
  };
}

/**
 * Evaluate a `bun test` output blob into a pass/fail `Result`, fail-closed.
 *
 * **D2:** returns an error Result when either the output could not be
 * parsed at all (`!counts.parsed`) or zero tests were actually executed
 * (`counts.executed === 0`) -- an empty, skip-only, or todo-only test file
 * must never be treated as a satisfied `Assert: test <path>` invariant.
 *
 * @param output - The raw combined stdout+stderr blob from a `bun test` run.
 * @param path   - The test file path, interpolated into the failure message.
 */
export function evaluateBunTestOutcome(output: string, path: string): Result<void> {
  const counts = parseBunTestCounts(output);

  if (!counts.parsed || counts.executed === 0) {
    return {
      ok: false,
      error: new Error(
        `Structural assertion failed: test "${path}" executed zero tests (bun test reported no executed tests; an empty, skip-only, or todo-only test file cannot satisfy this assertion)`,
      ),
    };
  }

  return { ok: true, value: undefined };
}
