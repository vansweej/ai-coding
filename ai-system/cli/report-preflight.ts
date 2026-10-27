import type { PreflightReport, PreflightViolation } from "../core/pipeline/preflight";

/** The outcome of rendering a preflight report for the CLI. */
export interface PreflightRenderResult {
  /** One human-readable line per violation, prefixed `PREFLIGHT ...`. */
  readonly lines: readonly string[];
  /** Count of violations that are (or were promoted to) errors. */
  readonly errorCount: number;
  /** Count of violations that remained warnings. */
  readonly warnCount: number;
  /** True when the run must abort before any dispatch (`errorCount > 0`). */
  readonly abort: boolean;
}

/** Effective severity after `--strict` promotion of warnings to errors. */
function effectiveSeverity(violation: PreflightViolation, strict: boolean): "error" | "warn" {
  if (violation.severity === "error") return "error";
  return strict ? "error" : "warn";
}

/**
 * Render a preflight report into CLI lines and counts. Pure; never throws.
 * Under `--strict`, warnings are promoted to errors and therefore abort.
 *
 * @param report - The preflight report to render.
 * @param strict - When true, promote warnings to errors.
 * @returns Rendered lines, error/warning counts, and the abort decision.
 */
export function reportPreflight(report: PreflightReport, strict: boolean): PreflightRenderResult {
  const lines: string[] = [];
  let errorCount = 0;
  let warnCount = 0;
  for (const violation of report.violations) {
    const severity = effectiveSeverity(violation, strict);
    if (severity === "error") {
      errorCount += 1;
      lines.push(`PREFLIGHT ERROR: [${violation.rule}] ${violation.message}`);
    } else {
      warnCount += 1;
      lines.push(`PREFLIGHT WARN: [${violation.rule}] ${violation.message}`);
    }
  }
  return { lines, errorCount, warnCount, abort: errorCount > 0 };
}
