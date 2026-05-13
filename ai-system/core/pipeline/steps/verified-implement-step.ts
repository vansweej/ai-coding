import { createFileWriterStep } from "@ai-coding/pipeline";
import type { PipelineContext, PipelineStep, Result, StepResult } from "@ai-coding/pipeline";
import type { AIAction, AIRequestEvent } from "@ai-coding/shared";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { orchestrate } from "../../orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "../definitions/language-configs";
import type { Step } from "../plan-parser";

const IMPLEMENT_RESULT_NAME = "verified-implement-output";

/** Retry limits for verified implementation. */
export interface RetryConfig {
  /** Local implementer attempts after the initial attempt. Defaults to 3. */
  readonly maxLocalRetries?: number;
  /** Escalated fixer attempts after local retries are exhausted. Defaults to 1. */
  readonly maxEscalationRetries?: number;
}

/** Options for creating a verified implement composite step. */
export interface VerifiedImplementStepOptions {
  readonly config: OrchestratorConfig;
  readonly workspace: string;
  readonly languageConfig: DevCycleLanguageConfig;
  readonly steps?: readonly Step[];
  readonly retryConfig?: RetryConfig;
}

/** Build the retry prompt used when verification fails. */
export function buildVerificationFailurePrompt(
  originalInstruction: string,
  writtenCode: string,
  errorOutput: string,
): string {
  return [
    "Fix the implementation so verification passes.",
    "Output ONLY fenced code blocks with relative file paths for files that need changes.",
    "",
    "Original instruction:",
    originalInstruction,
    "",
    "Previously written code:",
    writtenCode,
    "",
    "Verification error output:",
    errorOutput,
  ].join("\n");
}

function makeEvent(
  ctx: PipelineContext<AIRequestEvent>,
  action: AIAction,
  input: string,
): AIRequestEvent {
  return {
    ...ctx.event,
    action,
    payload: { ...ctx.event.payload, input },
  };
}

function buildImplementationPrompt(
  languageConfig: DevCycleLanguageConfig,
  instruction: string,
): string {
  return `Implement this ${languageConfig.languageHint} step. Output ONLY fenced code blocks with file paths.\n\nInstruction:\n${instruction}`;
}

function formatPhaseInstruction(steps: readonly Step[], phaseFeedback?: string): string {
  const stepInstructions = steps
    .map((step) => [`Step ${step.number}: ${step.title}`, "", step.body].join("\n"))
    .join("\n\n---\n\n");

  if (phaseFeedback === undefined) return stepInstructions;

  return [stepInstructions, "", "Phase verification feedback:", phaseFeedback].join("\n");
}

async function runImplementAttempt(
  ctx: PipelineContext<AIRequestEvent>,
  options: VerifiedImplementStepOptions,
  prompt: string,
  action: AIAction,
): Promise<Result<string>> {
  const llmOptions: LLMOptions = {
    system: options.languageConfig.implementSystem,
    temperature: action === "fix" ? 0.2 : 0.4,
  };
  const result = await orchestrate(makeEvent(ctx, action, prompt), options.config, llmOptions);
  if (!result.ok) return result;
  return { ok: true, value: result.value.response };
}

async function writeImplementation(
  ctx: PipelineContext<AIRequestEvent>,
  workspace: string,
  implementation: string,
): Promise<Result<StepResult>> {
  ctx.results.set(IMPLEMENT_RESULT_NAME, {
    stepName: IMPLEMENT_RESULT_NAME,
    output: implementation,
    durationMs: 0,
  });
  const writer = createFileWriterStep<AIRequestEvent>("write-files", {
    readFrom: IMPLEMENT_RESULT_NAME,
    baseDir: workspace,
  });
  return writer.execute(ctx);
}

async function runVerification(
  ctx: PipelineContext<AIRequestEvent>,
  steps: readonly PipelineStep<AIRequestEvent>[],
): Promise<Result<readonly StepResult[]>> {
  const completed: StepResult[] = [];
  for (const step of steps) {
    const result = await step.execute(ctx);
    if (!result.ok) return result;
    ctx.results.set(step.name, result.value);
    completed.push(result.value);
  }
  return { ok: true, value: completed };
}

async function implementAndWrite(
  ctx: PipelineContext<AIRequestEvent>,
  options: VerifiedImplementStepOptions,
  prompt: string,
  action: AIAction,
): Promise<Result<string>> {
  const implementResult = await runImplementAttempt(ctx, options, prompt, action);
  if (!implementResult.ok) return implementResult;

  const writeResult = await writeImplementation(ctx, options.workspace, implementResult.value);
  if (!writeResult.ok) return writeResult;
  ctx.results.set(writeResult.value.stepName, writeResult.value);

  return { ok: true, value: implementResult.value };
}

async function implementAllPhaseSteps(
  ctx: PipelineContext<AIRequestEvent>,
  options: VerifiedImplementStepOptions,
  steps: readonly Step[],
): Promise<Result<string>> {
  const implementations: string[] = [];
  for (const step of steps) {
    const prompt = buildImplementationPrompt(options.languageConfig, step.body);
    const result = await implementAndWrite(ctx, options, prompt, "edit");
    if (!result.ok) return result;
    implementations.push(result.value);
  }
  return { ok: true, value: implementations.join("\n\n") };
}

/** Create a composite step that implements, writes, verifies, and retries a phase step. */
export function createVerifiedImplementStep(
  name: string,
  options: VerifiedImplementStepOptions,
): PipelineStep<AIRequestEvent> {
  const maxLocalRetries = options.retryConfig?.maxLocalRetries ?? 3;
  const maxEscalationRetries = options.retryConfig?.maxEscalationRetries ?? 1;

  return {
    name,
    execute: async (ctx: PipelineContext<AIRequestEvent>): Promise<Result<StepResult>> => {
      const startedAt = Date.now();
      const originalInstruction = ctx.event.payload.input ?? "";
      const phaseSteps = options.steps;
      const verificationSteps = options.languageConfig.toolchainSteps(options.workspace);
      let prompt = originalInstruction;
      let implementation = "";
      let lastError: Error | undefined;
      let attemptNumber = 0;

      const totalImplementerAttempts = 1 + maxLocalRetries;
      for (; attemptNumber < totalImplementerAttempts; attemptNumber++) {
        const implementResult =
          phaseSteps === undefined
            ? await implementAndWrite(ctx, options, prompt, "edit")
            : attemptNumber === 0
              ? await implementAllPhaseSteps(ctx, options, phaseSteps)
              : await implementAndWrite(
                  ctx,
                  options,
                  buildImplementationPrompt(options.languageConfig, prompt),
                  "edit",
                );
        if (!implementResult.ok) return implementResult;
        implementation = implementResult.value;

        const verificationResult = await runVerification(ctx, verificationSteps);
        if (verificationResult.ok) {
          return {
            ok: true,
            value: {
              stepName: name,
              output: `Verified implementation after ${attemptNumber + 1} local attempt(s)`,
              durationMs: Date.now() - startedAt,
            },
          };
        }

        lastError = verificationResult.error;
        prompt = buildVerificationFailurePrompt(
          phaseSteps === undefined ? originalInstruction : formatPhaseInstruction(phaseSteps),
          implementation,
          lastError.message,
        );
      }

      for (
        let escalationAttempt = 0;
        escalationAttempt < maxEscalationRetries;
        escalationAttempt++
      ) {
        const fixPrompt = buildVerificationFailurePrompt(
          phaseSteps === undefined ? originalInstruction : formatPhaseInstruction(phaseSteps),
          implementation,
          lastError?.message ?? "Verification failed without diagnostics",
        );
        const fixResult = await implementAndWrite(
          ctx,
          options,
          buildImplementationPrompt(options.languageConfig, fixPrompt),
          "fix",
        );
        if (!fixResult.ok) return fixResult;
        implementation = fixResult.value;

        const verificationResult = await runVerification(ctx, verificationSteps);
        if (verificationResult.ok) {
          return {
            ok: true,
            value: {
              stepName: name,
              output: `Verified implementation after escalation attempt ${escalationAttempt + 1}`,
              durationMs: Date.now() - startedAt,
            },
          };
        }
        lastError = verificationResult.error;
      }

      return {
        ok: false,
        error: new Error(
          `Verified implement step "${name}" failed after ${totalImplementerAttempts} local attempt(s) and ${maxEscalationRetries} escalation attempt(s): ${lastError?.message ?? "unknown error"}`,
        ),
      };
    },
  };
}
