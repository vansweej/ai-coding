import type { CoverageDirective } from "../plan-parser";

/**
 * Determine if a diff qualifies for automatic coverage exemption.
 *
 * Returns true when the applied patches add zero new non-test, non-comment lines.
 * This prevents false positives when changes are purely structural (comments, test files).
 *
 * Parses added `+` lines from a unified `git diff`, ignoring:
 *   - Lines in files matching `*.test.ts`, `*.test.rs`, `*.test.cpp`, etc.
 *   - Lines that are pure comments (only whitespace + comment markers)
 *
 * @param diff - Unified git diff output
 * @returns true if the diff adds zero real lines (auto-exempt), false otherwise
 */
export function isAutoExempt(diff: string): boolean {
  const lines = diff.split("\n");
  let currentFile = "";

  for (const line of lines) {
    // Track which file we're in
    const fileMatch = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[2] ?? "";
      continue;
    }

    // Skip if we're in a test file
    if (currentFile.includes(".test.") || currentFile.includes("_test.")) {
      continue;
    }

    // Check for added lines (start with +, but not +++ which is a diff marker)
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1); // Remove the + prefix

      // Check if it's a pure comment line
      const trimmed = content.trim();
      if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#")) {
        continue;
      }

      // Found a real added line
      return false;
    }
  }

  // No real lines added
  return true;
}

/**
 * Resolve the effective coverage threshold for a phase.
 *
 * Combines the phase's coverage directive with auto-exempt logic:
 *   - If directive is `skip`: `gated: false` (no gate)
 *   - If auto-exempt is true: `gated: false` (no gate)
 *   - If directive is explicit threshold: that percent (gate enabled)
 *   - Otherwise: default 90% (gate enabled)
 *
 * The directive only overrides auto-exempt when it *raises* strictness.
 * For example, if auto-exempt applies (no gate), an explicit 95% threshold
 * will be applied because 95% is stricter than no gate. But an explicit 50%
 * threshold will not override auto-exempt because 50% is less strict.
 *
 * @param phaseCoverage - The phase's coverage directive
 * @param diff - The git diff of applied changes
 * @returns An object with `gated` (whether coverage is enforced) and `percent` (threshold if gated)
 */
export function resolveCoverageThreshold(
  phaseCoverage: CoverageDirective,
  diff: string,
): { gated: boolean; percent: number } {
  // Skip directive always disables the gate
  if (phaseCoverage.mode === "skip") {
    return { gated: false, percent: 0 };
  }

  // Auto-exempt takes precedence unless directive explicitly raises strictness
  const autoExempt = isAutoExempt(diff);

  if (autoExempt) {
    // Auto-exempt applies, but explicit threshold can override if it's stricter
    if (phaseCoverage.mode === "threshold") {
      // Any explicit threshold is stricter than auto-exempt (which has no gate)
      return { gated: true, percent: phaseCoverage.percent };
    }
    // Default mode with auto-exempt: no gate
    return { gated: false, percent: 0 };
  }

  // Not auto-exempt, so use the directive
  if (phaseCoverage.mode === "threshold") {
    return { gated: true, percent: phaseCoverage.percent };
  }

  // Default: 90% threshold
  return { gated: true, percent: 90 };
}
