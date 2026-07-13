import { $ } from "bun";

import type { Result } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "./definitions/language-configs";
import type { Phase } from "./plan-parser";
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
  readonly languageConfig: DevCycleLanguageConfig;
  readonly retryConfig?: RetryConfig;
  readonly commitPhase?: CommitPhase;
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
  const verifiedStep = createVerifiedImplementStep(`phase-${phase.number}`, {
    config: options.config,
    workspace: options.workspace,
    languageConfig: options.languageConfig,
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

  return {
    ok: true,
    value: {
      phaseNumber: phase.number,
      stepsCompleted: phase.steps.length,
      commitMessage: phase.commitMessage,
    },
  };
}
