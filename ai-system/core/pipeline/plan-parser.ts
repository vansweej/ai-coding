import type { Result } from "@ai-coding/pipeline";

/** A single implementation step within a phase. */
export interface Step {
  /** Step number (1-indexed). */
  readonly number: number;
  /** Step title extracted from the `### Step N:` heading. */
  readonly title: string;
  /** Freeform instruction body for the implementer. */
  readonly body: string;
}

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
  const currentSteps: Step[] = [];

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
    });
    currentPhaseNumber = undefined;
    currentPhaseTitle = undefined;
    currentCommitMessage = undefined;
    currentSteps.length = 0;
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
