import type { Result } from "@ai-coding/pipeline";

import type { PhaseRunResult, RunPhaseOptions } from "./phase-runner";
import { runPhase } from "./phase-runner";
import { parsePlanFile } from "./plan-parser";

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

  const phaseResults: PhaseRunResult[] = [];
  for (const phase of parsed.value.phases) {
    const result = await runPhase(phase, options);
    if (!result.ok) return result;
    phaseResults.push(result.value);
  }

  return { ok: true, value: { feature: parsed.value.feature, phases: phaseResults } };
}
