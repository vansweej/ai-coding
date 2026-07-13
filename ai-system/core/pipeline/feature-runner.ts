import type { Result } from "@ai-coding/pipeline";

import type { PhaseRunResult, RunPhaseOptions } from "./phase-runner";
import { runPhase } from "./phase-runner";
import { parsePlanFile } from "./plan-parser";
import { detectResumeState, resetToPhaseCommit } from "./resume";

/** Summary returned after a feature plan succeeds. */
export interface FeatureRunResult {
  readonly feature: string;
  readonly phases: readonly PhaseRunResult[];
}

/** Parse a plan file and run its phases sequentially, stopping on first failure. */
export async function runFeature(
  planContent: string,
  options: RunPhaseOptions,
): Promise<Result<FeatureRunResult>> {
  const parsed = parsePlanFile(planContent);
  if (!parsed.ok) return parsed;

  // Detect if a resume is needed
  const resumeState = await detectResumeState(options.workspace);
  let startPhaseIndex = 0;

  if (resumeState.needsResume && resumeState.lastPhaseNumber !== undefined) {
    // Reset to the last completed phase
    const resetResult = await resetToPhaseCommit(options.workspace, resumeState.lastPhaseNumber);
    if (!resetResult.ok) return resetResult;

    // Skip phases up to and including the last completed phase
    startPhaseIndex = resumeState.lastPhaseNumber;
  }

  const phaseResults: PhaseRunResult[] = [];
  for (let i = startPhaseIndex; i < parsed.value.phases.length; i++) {
    const phase = parsed.value.phases[i];
    const result = await runPhase(phase, options);
    if (!result.ok) return result;
    phaseResults.push(result.value);
  }

  return { ok: true, value: { feature: parsed.value.feature, phases: phaseResults } };
}
