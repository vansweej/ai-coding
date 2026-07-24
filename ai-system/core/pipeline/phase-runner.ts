import { execSync } from "node:child_process";
import { $ } from "bun";

import type { Result } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import {
  type DevCycleLanguageConfig,
  PLAN_CONFIG_FACTORIES,
  type PlanConfigFactory,
} from "./definitions/language-configs";
import type { LanguageName, Phase } from "./plan-parser";
import type { RetryConfig } from "./steps/verified-implement-step";
import { createVerifiedImplementStep } from "./steps/verified-implement-step";

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
