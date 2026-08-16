import { devShellPalette } from "@ai-coding/pipeline";
import type { Result } from "@ai-coding/pipeline";

import { CANDIDATE_TOOLS } from "./definitions/language-configs";
import type { PhaseRunResult, RunPhaseOptions } from "./phase-runner";
import { runPhase } from "./phase-runner";
import { parsePlanFile } from "./plan-parser";
import { detectResumeState, resetToPhaseCommit } from "./resume";

/** Summary returned after a feature plan succeeds. */
export interface FeatureRunResult {
  readonly feature: string;
  readonly phases: readonly PhaseRunResult[];
  readonly degradations: readonly string[];
}

/**
 * Options for running a feature plan. Identical to `RunPhaseOptions` except
 * `palette` is OMITTED here -- `runFeature` computes it exactly once per run
 * (via `devShellPalette`) and threads the same resolved palette through
 * every phase, rather than requiring the caller to probe the devShell
 * themselves or risking a fresh (possibly inconsistent) probe per phase.
 */
export type RunFeatureOptions = Omit<RunPhaseOptions, "palette">;

/**
 * Error indicating the workspace's devShell toolchain palette could not be
 * detected (e.g. a broken `flake.nix`, or `nix develop` itself failing).
 * Distinguishes an environment failure from an ordinary phase failure so
 * callers can map it to a hard environment-error exit code, same as
 * `BaselineCheckError`.
 */
export class DevShellPaletteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevShellPaletteError";
  }
}

/** Parse a plan file and run its phases sequentially, stopping on first failure. */
export async function runFeature(
  planContent: string,
  options: RunFeatureOptions,
): Promise<Result<FeatureRunResult>> {
  const parsed = parsePlanFile(planContent);
  if (!parsed.ok) return parsed;

  // Detect the workspace's devShell toolchain palette ONCE per run (not per
  // phase) -- a broken devShell is an environment problem that should abort
  // the whole run before any LLM call, not something to retry per phase.
  const paletteResult = await devShellPalette(options.workspace, CANDIDATE_TOOLS);
  if (!paletteResult.ok) {
    return {
      ok: false,
      error: new DevShellPaletteError(
        `Unable to detect the workspace's devShell toolchain palette: ${paletteResult.error.message}`,
      ),
    };
  }
  const palette = paletteResult.value;

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

  const degradations: string[] = [];
  const onDegrade = (detail: string, phaseNumber: number): void => {
    degradations.push(`Phase ${phaseNumber}: ${detail}`);
  };

  const phaseResults: PhaseRunResult[] = [];
  for (let i = startPhaseIndex; i < parsed.value.phases.length; i++) {
    const phase = parsed.value.phases[i];
    options.onProgress?.({ kind: "phase-start", phase: phase.number, title: phase.title });
    const result = await runPhase(phase, { ...options, palette, onDegrade: (detail) => onDegrade(detail, phase.number) });
    if (!result.ok) {
      options.onProgress?.({
        kind: "phase-fail",
        phase: phase.number,
        reason: result.error.message,
      });
      return result;
    }
    phaseResults.push(result.value);
    options.onProgress?.({
      kind: "phase-finish",
      phase: phase.number,
      commitMessage: phase.commitMessage,
    });
  }

  return { ok: true, value: { feature: parsed.value.feature, phases: phaseResults, degradations } };
}
