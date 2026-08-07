import type { Result } from "@ai-coding/pipeline";

import type { PhaseAssertion } from "./phase-assertions";
import { parseAssertion } from "./phase-assertions";

/** A single implementation step within a phase. */
export interface Step {
  /** Step number (1-indexed). */
  readonly number: number;
  /** Step title extracted from the `### Step N:` heading. */
  readonly title: string;
  /** Freeform instruction body for the implementer. */
  readonly body: string;
}

/** Coverage directive for a phase. */
export type CoverageDirective =
  | { readonly mode: "skip" }
  | { readonly mode: "threshold"; readonly percent: number }
  | { readonly mode: "default" };

/** A single phase within a plan file. */
export interface Phase {
  /** Phase number (1-indexed). */
  readonly number: number;
  /** Phase title extracted from the `## Phase N:` heading. */
  readonly title: string;
  /** Conventional commit message authored by the planning session. */
  readonly commitMessage: string;
  /** Ordered list of steps to execute in this phase. */
  readonly steps: readonly Step[];
  /** Coverage directive: skip, N%, or default (90%). */
  readonly coverage: CoverageDirective;
  /**
   * Author-declared structural assertions checked by the runner AFTER
   * verification and BEFORE commit. Optional and backward compatible: plans
   * without any `Assert:` lines parse to an omitted field.
   *
   * Supported directives (see `phase-assertions.ts` for full grammar):
   * `Assert: contains <path> :: <needle>`, `Assert: not-contains <path> :: <needle>`,
   * `Assert: exists <path>`, `Assert: not-exists <path>`, and
   * `Assert: matches <path> :: <regex>` -- an anchored-capable regex check
   * against the file's content (compiled with `new RegExp`); an unreadable
   * file or an invalid regex is a failure.
   */
  readonly assertions?: readonly PhaseAssertion[];
}

/** A fully parsed plan file. */
export interface PlanFile {
  /** Feature name extracted from the `# Feature:` heading. */
  readonly feature: string;
  /** Ordered list of phases to execute. */
  readonly phases: readonly Phase[];
}

const FEATURE_RE = /^#\s+Feature:\s*(.+)$/;
const PHASE_RE = /^##\s+Phase\s+(\d+):\s*(.+)$/;
const COMMIT_RE = /^Commit message:\s*(.+)$/;
const COVERAGE_RE = /^Coverage:\s*(.+)$/;
const ASSERT_RE = /^Assert:\s*(.+)$/;
const STEP_RE = /^###\s+Step\s+(\d+):\s*(.+)$/;

/**
 * Parse a structured plan file from its raw string content.
 *
 * Expected format:
 * ```
 * # Feature: <name>
 *
 * ## Phase 1: <title>
 *
 * Commit message: <conventional commit>
 * Coverage: skip | N% | (omitted for default 90%)
 *
 * ### Step 1: <title>
 *
 * <freeform instruction body>
 *
 * ### Step 2: <title>
 *
 * <instruction>
 *
 * ## Phase 2: <title>
 * ...
 * ```
 *
 * Validation rules:
 *   - Must have a `# Feature:` heading.
 *   - Must have at least one `## Phase N:` section.
 *   - Each phase must have a `Commit message:` line.
 *   - Each phase may have an optional `Coverage:` line (skip, N%, or omitted for default).
 *   - Each phase must have at least one `### Step N:` section.
 *
 * @param content - Raw plan file content (UTF-8 string).
 * @returns A `Result<PlanFile>` — ok on success, error with a descriptive message on failure.
 */
export function parsePlanFile(content: string): Result<PlanFile> {
  const lines = content.split("\n");

  let feature: string | undefined;
  const phases: Phase[] = [];

  let currentPhaseNumber: number | undefined;
  let currentPhaseTitle: string | undefined;
  let currentCommitMessage: string | undefined;
  let currentCoverage: CoverageDirective = { mode: "default" };
  const currentSteps: Step[] = [];
  const currentAssertions: PhaseAssertion[] = [];

  let currentStepNumber: number | undefined;
  let currentStepTitle: string | undefined;
  const currentStepBodyLines: string[] = [];

  function flushStep(): void {
    if (currentStepNumber === undefined || currentStepTitle === undefined) return;
    currentSteps.push({
      number: currentStepNumber,
      title: currentStepTitle,
      body: currentStepBodyLines.join("\n").trim(),
    });
    currentStepNumber = undefined;
    currentStepTitle = undefined;
    currentStepBodyLines.length = 0;
  }

  function flushPhase(): Result<void> {
    if (currentPhaseNumber === undefined || currentPhaseTitle === undefined) {
      return { ok: true, value: undefined };
    }
    flushStep();
    if (!currentCommitMessage) {
      return {
        ok: false,
        error: new Error(`Phase ${currentPhaseNumber} is missing a "Commit message:" line`),
      };
    }
    if (currentSteps.length === 0) {
      return {
        ok: false,
        error: new Error(`Phase ${currentPhaseNumber} has no steps`),
      };
    }
    phases.push({
      number: currentPhaseNumber,
      title: currentPhaseTitle,
      commitMessage: currentCommitMessage,
      steps: [...currentSteps],
      coverage: currentCoverage,
      assertions: [...currentAssertions],
    });
    currentPhaseNumber = undefined;
    currentPhaseTitle = undefined;
    currentCommitMessage = undefined;
    currentCoverage = { mode: "default" };
    currentSteps.length = 0;
    currentAssertions.length = 0;
    return { ok: true, value: undefined };
  }

  for (const line of lines) {
    const featureMatch = FEATURE_RE.exec(line);
    if (featureMatch) {
      feature = featureMatch[1].trim();
      continue;
    }

    const phaseMatch = PHASE_RE.exec(line);
    if (phaseMatch) {
      const flushResult = flushPhase();
      if (!flushResult.ok) return flushResult;
      currentPhaseNumber = Number(phaseMatch[1]);
      currentPhaseTitle = phaseMatch[2].trim();
      continue;
    }

    const commitMatch = COMMIT_RE.exec(line);
    if (commitMatch && currentPhaseNumber !== undefined) {
      currentCommitMessage = commitMatch[1].trim();
      continue;
    }

    const coverageMatch = COVERAGE_RE.exec(line);
    if (coverageMatch && currentPhaseNumber !== undefined) {
      const coverageValue = coverageMatch[1].trim();
      if (coverageValue === "skip") {
        currentCoverage = { mode: "skip" };
      } else if (coverageValue.endsWith("%")) {
        const percentStr = coverageValue.slice(0, -1);
        const percent = Number(percentStr);
        if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
          return {
            ok: false,
            error: new Error(
              `Phase ${currentPhaseNumber} has invalid coverage percent: "${coverageValue}" (must be 0-100)`,
            ),
          };
        }
        currentCoverage = { mode: "threshold", percent };
      } else {
        return {
          ok: false,
          error: new Error(
            `Phase ${currentPhaseNumber} has invalid coverage directive: "${coverageValue}" (must be "skip" or "N%")`,
          ),
        };
      }
      continue;
    }

    const assertMatch = ASSERT_RE.exec(line);
    if (assertMatch && currentPhaseNumber !== undefined) {
      const parsed = parseAssertion(assertMatch[1].trim());
      if (!parsed.ok) {
        return {
          ok: false,
          error: new Error(
            `Phase ${currentPhaseNumber} has an invalid Assert directive: ${parsed.error.message}`,
          ),
        };
      }
      currentAssertions.push(parsed.value);
      continue;
    }

    const stepMatch = STEP_RE.exec(line);
    if (stepMatch) {
      flushStep();
      currentStepNumber = Number(stepMatch[1]);
      currentStepTitle = stepMatch[2].trim();
      continue;
    }

    if (currentStepNumber !== undefined) {
      currentStepBodyLines.push(line);
    }
  }

  const finalFlush = flushPhase();
  if (!finalFlush.ok) return finalFlush;

  if (!feature) {
    return { ok: false, error: new Error('Plan file is missing a "# Feature:" heading') };
  }

  if (phases.length === 0) {
    return { ok: false, error: new Error("Plan file has no phases") };
  }

  return { ok: true, value: { feature, phases } };
}
