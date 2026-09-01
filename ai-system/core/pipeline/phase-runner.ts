import { execFileSync, execSync } from "node:child_process";
import { $ } from "bun";

import type { PipelineContext, Result, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import type { ToolchainDescriptor } from "./definitions/language-configs";

import { buildGitCleanArgs } from "./git-clean-args";
import { checkAssertions } from "./phase-assertions";
import { PHASE_FAILURE_REASONS, phaseHardFail } from "./phase-hard-fail";
import type { Phase } from "./plan-parser";
import type { OnProgress } from "./progress";
import { getTouchedFiles, route } from "./routing/route";
import type { RetryConfig } from "./steps/verified-implement-step";
import { createVerifiedImplementStep } from "./steps/verified-implement-step";

/**
 * Error indicating a baseline-green precondition check failed on the untouched
 * tree, before any implementation attempt. Distinguishes environment/toolchain
 * failures (should halt the whole run) from ordinary phase verification
 * failures (which retry/escalate normally).
 */
export class BaselineCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaselineCheckError";
  }
}

/** Summary returned after a phase succeeds. */
export interface PhaseRunResult {
  readonly phaseNumber: number;
  readonly stepsCompleted: number;
  readonly commitMessage: string;
  /** SHA of the phase's commit. Absent for verify-only phases, which commit nothing. */
  readonly commitHash?: string;
}

/** Function used to commit a successful phase. */
export type CommitPhase = (
  workspace: string,
  commitMessage: string,
  phaseNumber: number,
  runId?: string,
) => Promise<Result<string>>;

/** Runtime dependencies for executing a phase. */
export interface RunPhaseOptions {
  readonly config: OrchestratorConfig;
  readonly workspace: string;
  /** Optional path to the active plan file; excluded from `git clean` during working-tree restores. */
  readonly planPath?: string;
  /**
   * Correlation id minted once per plan-cycle run. Stamped as a `Run-Id:`
   * git commit trailer on every phase commit and carried in ledger lines.
   * Optional for backward-compat with tests that construct options directly.
   */
  readonly runId?: string;
  /**
   * Set of tool names detected as available in the workspace's devShell
   * (see `devShellPalette` in `@ai-coding/pipeline`, computed once per run
   * by `runFeature`). Drives per-file routing (`route`), context discovery
   * (`paletteExtensions`), the implement prompt (`composeImplementSystem`),
   * and verification (`runUnionVerification`) -- replaces the former
   * `defaultLanguage`/`factories` pair entirely.
   */
  readonly palette: ReadonlySet<string>;
  readonly retryConfig?: RetryConfig;
  readonly commitPhase?: CommitPhase;
  /**
   * Optional progress reporter invoked with structured events as phases and
   * steps execute (phase-start/finish/fail from the feature runner; the
   * step-level and phase-attempt events from the verified-implement step).
   * When omitted, no events are constructed and there is no overhead.
   */
  readonly onProgress?: OnProgress;
  readonly onDegrade?: (phaseNumber: number, detail: string) => void;
  /**
   * Optional sink for persisting real gate stdout/stderr/exitCode/duration
   * to the ledger, correlated by runId and phase. The `phase` argument is
   * the plan phase number the gate ran under; `runPhase` curries this in
   * automatically before threading the callback down to the verified-
   * implement step, so callers of `runPhase` only need to supply the
   * 5-arg (name, stdout, stderr, exitCode, durationMs) shape -- see
   * `VerifiedImplementStepOptions.onGateOutput`.
   */
  readonly onGateOutput?: (
    name: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    durationMs: number,
    phase?: number,
  ) => void;
}

/**
 * Commit all phase changes with the plan-authored commit message and Phase / Run-Id trailers.
 *
 * Returns the resulting commit's SHA (via `git rev-parse HEAD`), not the commit message,
 * so callers can correlate a completed phase with its exact commit.
 */
export async function commitPhaseChanges(
  workspace: string,
  commitMessage: string,
  phaseNumber?: number,
  runId?: string,
): Promise<Result<string>> {
  try {
    // Build trailers: Phase: N (resume tracking) + Run-Id: <id> (correlation)
    const trailers: string[] = [];
    if (phaseNumber !== undefined) trailers.push(`Phase: ${phaseNumber}`);
    if (runId !== undefined) trailers.push(`Run-Id: ${runId}`);
    const messageWithTrailer =
      trailers.length > 0 ? `${commitMessage}\n\n${trailers.join("\n")}` : commitMessage;

    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -m ${messageWithTrailer}`.cwd(workspace).quiet();
    const sha = (await $`git rev-parse HEAD`.cwd(workspace).quiet().text()).trim();
    return { ok: true, value: sha };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function buildStepEvent(stepInstruction: string): AIRequestEvent {
  return {
    id: `phase-step-${Date.now()}`,
    timestamp: Date.now(),
    source: "cli",
    modeHint: "agentic",
    action: "task",
    payload: { input: stepInstruction },
  };
}

function buildPhaseInstruction(phase: Phase): string {
  return phase.steps
    .map((step) => [`Step ${step.number}: ${step.title}`, "", step.body].join("\n"))
    .join("\n\n---\n\n");
}

/**
 * Capture the current working-tree diff; returns empty string if git is
 * unavailable. Passed through to the routed toolchains' coverage-exemption
 * logic (see `resolveCoverageThreshold`/`createRustPlanConfig`) -- mirrors
 * the same best-effort, once-per-phase snapshot the legacy
 * `factory(coverage, diff)` path always used.
 */
function safeGitDiff(workspace: string): string {
  try {
    return execSync("git diff", { cwd: workspace, encoding: "utf8" });
  } catch {
    return "";
  }
}

/**
 * Returns whether the workspace has any net change in its working tree
 * (tracked-file modifications, additions, deletions, or untracked files) as
 * reported by `git status --porcelain`.
 *
 * FALSE-GREEN GUARD: a phase can report verification success while its intended
 * edits never landed (e.g. a partial/failed patch apply). Committing then
 * produces an empty commit that the pipeline records as `[ok]`. This function
 * lets `runPhase` refuse to commit when the tree is provably clean.
 *
 * FAIL-OPEN on git error: if `git status` cannot run (git unavailable, not a
 * repository), we cannot prove the tree is clean, so we return `true`. The gate
 * therefore only ever blocks when git DEFINITIVELY reports an empty tree; it
 * never false-blocks a legitimate change in a non-git context.
 *
 * @param workspace - Absolute path to the workspace root.
 * @returns `true` if the tree has changes or git status is indeterminate;
 *   `false` only when git succeeds and reports a clean tree.
 */
export function hasNetWorkingTreeChange(workspace: string): boolean {
  try {
    const status = execSync("git status --porcelain", { cwd: workspace, encoding: "utf8" });
    return status.trim().length > 0;
  } catch {
    return true;
  }
}

/**
 * Restore the working tree to the pre-phase HEAD after a phase abort.
 *
 * Runs `git reset --hard HEAD` followed by `git clean -fd` (NO `-x` — must
 * honor `.gitignore` so build artifacts / ignored files survive; only
 * untracked non-ignored stray files are removed), both with `cwd: workspace`.
 *
 * NEVER THROWS: any failure (e.g. not a git repo, git unavailable) is caught
 * and surfaced as a `restore-failed` progress event so the original phase
 * failure is never masked. The tree may remain dirty after a failure, but the
 * caller's error is still returned.
 *
 * @param workspace  - Absolute path to the workspace root.
 * @param phase      - The phase number being aborted, for the progress event.
 * @param onProgress - Optional progress reporter; silent when omitted.
 */
export function restoreWorkingTree(
  workspace: string,
  phase: number,
  onProgress?: OnProgress,
  planPath?: string,
): void {
  try {
    execSync("git reset --hard HEAD", { cwd: workspace, encoding: "utf8" });
    execFileSync("git", buildGitCleanArgs(workspace, planPath), {
      cwd: workspace,
      encoding: "utf8",
    });
  } catch (err) {
    onProgress?.({
      kind: "restore-failed",
      phase,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Returns the deduplicated (by descriptor id) set of whole-repo-validator
 * toolchain descriptors implicated by the files currently touched in the
 * workspace (per `getTouchedFiles`), given the workspace's devShell palette.
 *
 * Pure detection only -- never executes a toolchain command. This can run
 * safely even when the underlying tool (e.g. `nixpkgs-fmt`) is not actually
 * installed, since `route()` only checks driver-tool membership in the
 * palette, not whether the command succeeds.
 */
export function findImplicatedWholeRepoValidators(
  workspace: string,
  palette: ReadonlySet<string>,
): readonly ToolchainDescriptor[] {
  const implicated = new Map<string, ToolchainDescriptor>();
  for (const file of getTouchedFiles(workspace)) {
    const descriptor = route(file, palette);
    if (descriptor?.isWholeRepoValidator) {
      implicated.set(descriptor.id, descriptor);
    }
  }
  return Array.from(implicated.values());
}

/**
 * Runs every toolchain step of every given (whole-repo-validator) descriptor
 * against the workspace's CURRENT on-disk state. Used exclusively against a
 * `git stash`-cleaned tree by `attributePhaseFailure` -- this function itself
 * has no git side effects, so it can be unit-tested directly with fake
 * descriptors.
 */
export async function runValidatorSteps(
  workspace: string,
  descriptors: readonly ToolchainDescriptor[],
): Promise<Result<void>> {
  const ctx: PipelineContext<AIRequestEvent> = {
    event: buildStepEvent(""),
    results: new Map<string, StepResult>(),
  };
  for (const descriptor of descriptors) {
    for (const step of descriptor.toolchainSteps(workspace)) {
      const result = await step.execute(ctx);
      if (!result.ok) return result;
      ctx.results.set(step.name, result.value);
    }
  }
  return { ok: true, value: undefined };
}

/**
 * Given a phase's verification failure, decides whether it is an ORDINARY
 * phase failure (this phase's own implementation is wrong -- resumable,
 * retryable) or an ENVIRONMENT failure (a whole-repo validator -- e.g.
 * `nix flake check`, whole-repo `shellcheck` -- was already broken before
 * this phase touched anything).
 *
 * LAZY ATTRIBUTION (replaces the former eager `runBaselineCheck`, which paid
 * the cost of every whole-repo validator on every phase regardless of
 * whether that phase touched anything relevant -- see the fix#6 lesson in
 * memory 969218af): only runs when a phase has ALREADY failed, and only
 * re-checks the specific whole-repo validator(s) implicated by files this
 * phase actually touched.
 *
 * Mechanism: `git stash` (removing this phase's changes) -> re-run just the
 * implicated validator(s) on the clean pre-phase tree -> `git stash pop`
 * (always, even on failure, so the dirty tree is never left stashed) ->
 * clean tree ALSO fails => the environment was already broken
 * (`BaselineCheckError`, caller treats as exit 3); clean tree passes => this
 * phase's own implementation broke it (return the original failure
 * unchanged, exit 2 / ordinary retry).
 *
 * If `git stash` itself fails (e.g. nothing to stash, or git unavailable),
 * attribution is skipped entirely and the original failure is returned
 * unchanged -- never silently mask a real phase failure with a stash error.
 */
export async function attributePhaseFailure(
  workspace: string,
  palette: ReadonlySet<string>,
  originalFailure: Result<PhaseRunResult>,
): Promise<Result<PhaseRunResult>> {
  if (originalFailure.ok) return originalFailure;

  // Passthrough: a MappedToolchainUnavailableError (name-checked here to
  // avoid a cross-module import cycle with feature-runner.ts, mirroring the
  // PhaseHardFailError name-based convention) is already an environment
  // error produced by verifyOrFail's palette-mode guard in
  // verified-implement-step.ts. It must propagate unchanged -- never
  // re-wrapped as a BaselineCheckError -- so it reaches reportFeatureFailure
  // and exits 3.
  if (originalFailure.error.name === "MappedToolchainUnavailableError") {
    return originalFailure;
  }

  const implicated = findImplicatedWholeRepoValidators(workspace, palette);
  if (implicated.length === 0) return originalFailure;

  try {
    await $`git stash`.cwd(workspace).quiet();
  } catch {
    // Defensive: `git stash` failing while there IS a tracked, dirty,
    // whole-repo-validator-implicating file is not reliably reproducible in
    // a test environment (a clean tree makes `git stash` a no-op that exits
    // 0, not an error). Kept as a safety net so a stash failure can never
    // masquerade as a false BaselineCheckError.
    return originalFailure;
  }

  try {
    const cleanTreeResult = await runValidatorSteps(workspace, implicated);
    if (!cleanTreeResult.ok) {
      return {
        ok: false,
        error: new BaselineCheckError(
          `Whole-repo validator failed on the clean pre-phase tree (broken environment, not this phase's implementation): ${cleanTreeResult.error.message}`,
        ),
      };
    }
    return originalFailure;
  } finally {
    try {
      await $`git stash pop`.cwd(workspace).quiet();
    } catch {
      // If pop fails there is nothing safer to do than surface the original
      // failure -- masking it with a stash error would hide the real signal.
    }
  }
}

/** Run every implementation step in a phase, verify once, then auto-commit. */
export async function runPhase(
  phase: Phase,
  options: RunPhaseOptions,
): Promise<Result<PhaseRunResult>> {
  // Store phase context in memory if memory client is available
  if (options.config.memory) {
    const phaseContext = JSON.stringify({
      phaseNumber: phase.number,
      title: phase.title,
      commitMessage: phase.commitMessage,
      stepsCount: phase.steps.length,
      startedAt: Date.now(),
    });

    await options.config.memory.remember(phaseContext, 0.8);
  }

  // Verify-only phases run their Assert: lines only. They skip the
  // implement/verify step and net-change gate, commit nothing, and stamp no
  // Phase trailer, so they are transparent to resume because they are
  // idempotent by construction.
  if (phase.verifyOnly) {
    if ((phase.assertions ?? []).length === 0) {
      return phaseHardFail(
        phase.number,
        PHASE_FAILURE_REASONS.structuralAssertion,
        "verify-only phase declared no assertions",
      );
    }

    const assertionResult = await checkAssertions(options.workspace, phase.assertions ?? []);
    if (!assertionResult.ok) {
      restoreWorkingTree(options.workspace, phase.number, options.onProgress, options.planPath);
      return phaseHardFail(
        phase.number,
        PHASE_FAILURE_REASONS.structuralAssertion,
        `failed a structural assertion: ${assertionResult.error.message}`,
      );
    }

    return {
      ok: true,
      value: {
        phaseNumber: phase.number,
        stepsCompleted: 0,
        commitMessage: phase.commitMessage,
      },
    };
  }

  // Curry the phase number into onGateOutput so createVerifiedImplementStep
  // (and everything it threads the callback into) only needs to supply the
  // 5-arg (name, stdout, stderr, exitCode, durationMs) shape.
  const gateOutputForThisPhase = options.onGateOutput
    ? (name: string, stdout: string, stderr: string, exitCode: number, durationMs: number): void =>
        options.onGateOutput?.(name, stdout, stderr, exitCode, durationMs, phase.number)
    : undefined;

  const verifiedStep = createVerifiedImplementStep(`phase-${phase.number}`, {
    config: options.config,
    workspace: options.workspace,
    planPath: options.planPath,
    palette: options.palette,
    coverage: phase.coverage,
    diff: safeGitDiff(options.workspace),
    retryConfig: options.retryConfig,
    steps: phase.steps,
    phaseNumber: phase.number,
    onProgress: options.onProgress,
    onDegrade: options.onDegrade,
    onGateOutput: gateOutputForThisPhase,
  });
  const result = await verifiedStep.execute({
    event: buildStepEvent(buildPhaseInstruction(phase)),
    results: new Map(),
  });
  if (!result.ok) {
    const attributed = await attributePhaseFailure(options.workspace, options.palette, result);
    restoreWorkingTree(options.workspace, phase.number, options.onProgress, options.planPath);
    return attributed;
  }

  if (!hasNetWorkingTreeChange(options.workspace)) {
    restoreWorkingTree(options.workspace, phase.number, options.onProgress);
    return phaseHardFail(
      phase.number,
      PHASE_FAILURE_REASONS.noNetChange,
      "produced no net working-tree change; refusing to commit an empty phase (possible false-green partial apply)",
    );
  }

  const assertionResult = await checkAssertions(options.workspace, phase.assertions ?? []);
  if (!assertionResult.ok) {
    restoreWorkingTree(options.workspace, phase.number, options.onProgress);
    return phaseHardFail(
      phase.number,
      PHASE_FAILURE_REASONS.structuralAssertion,
      `failed a structural assertion: ${assertionResult.error.message}`,
    );
  }

  const commit = options.commitPhase ?? commitPhaseChanges;
  const commitResult = await commit(
    options.workspace,
    phase.commitMessage,
    phase.number,
    options.runId,
  );
  if (!commitResult.ok) return commitResult;

  // Store phase completion in memory if memory client is available
  if (options.config.memory) {
    const completionContext = JSON.stringify({
      phaseNumber: phase.number,
      status: "completed",
      stepsCompleted: phase.steps.length,
      completedAt: Date.now(),
    });

    await options.config.memory.remember(completionContext, 0.9);
  }

  return {
    ok: true,
    value: {
      phaseNumber: phase.number,
      stepsCompleted: phase.steps.length,
      commitMessage: phase.commitMessage,
      commitHash: commitResult.value,
    },
  };
}
