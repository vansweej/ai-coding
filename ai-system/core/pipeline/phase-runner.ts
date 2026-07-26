import { execSync } from "node:child_process";
import { $ } from "bun";

import type { PipelineContext, Result, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import {
  type DevCycleLanguageConfig,
  PLAN_CONFIG_FACTORIES,
  type PlanConfigFactory,
} from "./definitions/language-configs";
import type { LanguageName, Phase } from "./plan-parser";
import type { OnProgress } from "./progress";
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
}

/** Function used to commit a successful phase. */
export type CommitPhase = (
  workspace: string,
  commitMessage: string,
  phaseNumber: number,
) => Promise<Result<string>>;

/** Runtime dependencies for executing a phase. */
export interface RunPhaseOptions {
  readonly config: OrchestratorConfig;
  readonly workspace: string;
  /**
   * Default language used when a phase has no `Language:` directive.
   * Always set explicitly — no silent fallback.
   */
  readonly defaultLanguage: LanguageName;
  /**
   * Factory registry used to resolve the per-phase `DevCycleLanguageConfig`.
   * Defaults to `PLAN_CONFIG_FACTORIES` when omitted.
   * Languages absent from the registry cause an immediate error so unimplemented
   * language support fails loudly rather than silently using the wrong toolchain.
   */
  readonly factories?: Readonly<Partial<Record<LanguageName, PlanConfigFactory>>>;
  readonly retryConfig?: RetryConfig;
  readonly commitPhase?: CommitPhase;
  /**
   * Optional progress reporter invoked with structured events as phases and
   * steps execute (phase-start/finish/fail from the feature runner; the
   * step-level and phase-attempt events from the verified-implement step).
   * When omitted, no events are constructed and there is no overhead.
   */
  readonly onProgress?: OnProgress;
}

/** Capture the current working-tree diff; returns empty string if git is unavailable. */
function safeGitDiff(workspace: string): string {
  try {
    return execSync("git diff", { cwd: workspace, encoding: "utf8" });
  } catch {
    return "";
  }
}

/** Commit all phase changes with the plan-authored commit message and Phase trailer. */
export async function commitPhaseChanges(
  workspace: string,
  commitMessage: string,
  phaseNumber?: number,
): Promise<Result<string>> {
  try {
    // Add Phase: N trailer to the commit message for resume tracking
    const messageWithTrailer =
      phaseNumber !== undefined ? `${commitMessage}\n\nPhase: ${phaseNumber}` : commitMessage;

    await $`git add -A`.cwd(workspace).quiet();
    await $`git commit -m ${messageWithTrailer}`.cwd(workspace).quiet();
    return { ok: true, value: commitMessage };
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
 * Run a language config's toolchainSteps once against the untouched tree,
 * before any implementation attempt. Any step failure is wrapped in a
 * BaselineCheckError so callers can distinguish it from a normal phase failure.
 */
async function runBaselineCheck(
  workspace: string,
  languageConfig: DevCycleLanguageConfig,
): Promise<Result<void>> {
  const steps = languageConfig.toolchainSteps(workspace);
  const ctx: PipelineContext<AIRequestEvent> = {
    event: buildStepEvent(""),
    results: new Map<string, StepResult>(),
  };
  for (const step of steps) {
    const result = await step.execute(ctx);
    if (!result.ok) {
      return {
        ok: false,
        error: new BaselineCheckError(
          `Baseline check failed at step "${step.name}" before any implementation attempt: ${result.error.message}`,
        ),
      };
    }
    ctx.results.set(step.name, result.value);
  }
  return { ok: true, value: undefined };
}

/** Run every implementation step in a phase, verify once, then auto-commit. */
export async function runPhase(
  phase: Phase,
  options: RunPhaseOptions,
): Promise<Result<PhaseRunResult>> {
  // Resolve the language for this phase (per-phase directive wins over default)
  const language = phase.language ?? options.defaultLanguage;
  const factories = options.factories ?? PLAN_CONFIG_FACTORIES;
  const factory = factories[language];
  if (factory === undefined) {
    return {
      ok: false,
      error: new Error(
        `Phase ${phase.number} uses unregistered language "${language}". Add a factory to PLAN_CONFIG_FACTORIES or pass a custom factories map.`,
      ),
    };
  }
  const diff = safeGitDiff(options.workspace);
  const languageConfig: DevCycleLanguageConfig = factory(phase.coverage, diff);

  if (languageConfig.baselineCheck) {
    const baselineResult = await runBaselineCheck(options.workspace, languageConfig);
    if (!baselineResult.ok) return baselineResult;
  }

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

  const verifiedStep = createVerifiedImplementStep(`phase-${phase.number}`, {
    config: options.config,
    workspace: options.workspace,
    languageConfig: languageConfig,
    retryConfig: options.retryConfig,
    steps: phase.steps,
    phaseNumber: phase.number,
    onProgress: options.onProgress,
  });
  const result = await verifiedStep.execute({
    event: buildStepEvent(buildPhaseInstruction(phase)),
    results: new Map(),
  });
  if (!result.ok) return result;

  const commit = options.commitPhase ?? commitPhaseChanges;
  const commitResult = await commit(options.workspace, phase.commitMessage, phase.number);
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
    },
  };
}
