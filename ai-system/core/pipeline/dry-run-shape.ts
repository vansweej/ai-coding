import type { PlanFile } from "./plan-parser";
import { route } from "./routing/route";

/** Per-phase predicted shape summary. */
export interface PredictedPhaseShape {
  readonly phase: number;
  readonly title: string;
  readonly stepCount: number;
  readonly assertCount: number;
  readonly coverage: string;
  /**
   * Best-effort warning: true when every declared Assert path (if any)
   * routes to no toolchain (the vacuous/floor-only case). This is NOT an
   * exact prediction -- it only inspects the Assert directive paths
   * declared in the plan, not the actual files the phase will touch.
   */
  readonly vacuousFloorOnlyWarning: boolean;
}

/** Predicted run shape for an entire parsed plan file. */
export interface PredictedRunShape {
  readonly feature: string;
  readonly phaseCount: number;
  readonly phases: readonly PredictedPhaseShape[];
}

/**
 * Format a `CoverageDirective` as a short human-readable string, matching
 * the plan-file directive syntax (`skip`, `N%`, or `default`).
 */
function formatCoverage(coverage: PlanFile["phases"][number]["coverage"]): string {
  if (coverage.mode === "skip") return "skip";
  if (coverage.mode === "threshold") return `${coverage.percent}%`;
  return "default";
}

/**
 * Best-effort check: does every declared Assert path in this phase route to
 * no toolchain (the no-toolchain floor)? Returns false when there are no
 * assertions at all (nothing to flag) or when at least one asserted path
 * routes to a real toolchain. This is deliberately best-effort -- it only
 * consults the plan's declared Assert paths via the pure `route()` function,
 * not the actual files the phase will touch during execution.
 */
function isVacuousFloorOnly(
  assertions: PlanFile["phases"][number]["assertions"],
  palette: ReadonlySet<string>,
): boolean {
  const paths = (assertions ?? []).map((assertion) => assertion.path);
  if (paths.length === 0) return false;
  return paths.every((path) => route(path, palette) === null);
}

/**
 * Predict the run shape for a parsed plan file without dispatching to any
 * model. Walks every phase and reports phase/step/assert counts and
 * coverage settings, plus a best-effort vacuous-floor-only warning per
 * phase.
 *
 * Pure function: no I/O beyond the passed-in `palette` (already resolved by
 * the caller via `devShellPalette`), never dispatches, never mutates the
 * workspace.
 *
 * @param plan    - The already-parsed plan file.
 * @param palette - Set of tool names detected as available in the devShell.
 */
export function predictRunShape(plan: PlanFile, palette: ReadonlySet<string>): PredictedRunShape {
  const phases: PredictedPhaseShape[] = plan.phases.map((phase) => ({
    phase: phase.number,
    title: phase.title,
    stepCount: phase.steps.length,
    assertCount: (phase.assertions ?? []).length,
    coverage: formatCoverage(phase.coverage),
    vacuousFloorOnlyWarning: isVacuousFloorOnly(phase.assertions, palette),
  }));

  return {
    feature: plan.feature,
    phaseCount: plan.phases.length,
    phases,
  };
}

/**
 * Format a `PredictedRunShape` as a human-readable stdout summary.
 *
 * @param shape - The predicted run shape.
 */
export function formatPredictedRunShape(shape: PredictedRunShape): string {
  const lines: string[] = [
    `Predicted run shape: "${shape.feature}" — ${shape.phaseCount} phase(s)`,
  ];

  for (const phase of shape.phases) {
    const warning = phase.vacuousFloorOnlyWarning
      ? "  [WARN: all declared Assert paths route to no toolchain — best-effort]"
      : "";
    lines.push(
      `  Phase ${phase.phase}: ${phase.title} — ${phase.stepCount} step(s), ` +
        `${phase.assertCount} assert(s), coverage=${phase.coverage}${warning}`,
    );
  }

  return lines.join("\n");
}

/**
 * Build the `run-shape` kind ledger-line payload from a `PredictedRunShape`,
 * matching the shape `createLedgerWriter`'s `write()` accepts (caller stamps
 * `schema_version`, `runId`, `ts`, and `kind` around this payload).
 *
 * @param shape - The predicted run shape.
 */
export function runShapeToLedgerPayload(shape: PredictedRunShape): Record<string, unknown> {
  return {
    feature: shape.feature,
    phaseCount: shape.phaseCount,
    phases: shape.phases.map((phase) => ({
      phase: phase.phase,
      title: phase.title,
      stepCount: phase.stepCount,
      assertCount: phase.assertCount,
      coverage: phase.coverage,
      vacuousFloorOnlyWarning: phase.vacuousFloorOnlyWarning,
    })),
  };
}
