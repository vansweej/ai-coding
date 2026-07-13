import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execSync } from "node:child_process";
import type { PipelineContext, PipelineStep, Result, StepResult } from "@ai-coding/pipeline";
import type { AIAction, AIRequestEvent } from "@ai-coding/shared";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { orchestrate } from "../../orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "../definitions/language-configs";
import type { Step } from "../plan-parser";
import { parsePatch } from "./parse-patch";
import { applyPatch } from "./apply-patch-step";

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

/**
 * Build the retry prompt used when verification fails.
 *
 * Includes the current on-disk content of all files touched by the phase,
 * so the model computes SEARCH anchors against the file's present state
 * (not the original bytes). This is critical for patch anchoring to work
 * correctly across multiple retry attempts.
 */
export function buildVerificationFailurePrompt(
  originalInstruction: string,
  writtenCode: string,
  errorOutput: string,
  currentFileContents?: string,
): string {
  const parts = [
    "Fix the implementation so verification passes.",
    "Output ONLY aider-style SEARCH/REPLACE patches for files that need changes.",
    "",
    "Original instruction:",
    originalInstruction,
    "",
    "Previously written code:",
    writtenCode,
    "",
  ];

  if (currentFileContents) {
    parts.push("Current file contents:");
    parts.push(currentFileContents);
    parts.push("");
  }

  parts.push("Verification error output:");
  parts.push(errorOutput);

  return parts.join("\n");
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
  siblingContext?: string,
): string {
  const contextBlock = siblingContext ? `${siblingContext}\n\n---\n\n` : "";
  return `${contextBlock}Implement this ${languageConfig.languageHint} step. Output ONLY fenced code blocks with file paths.\n\nInstruction:\n${instruction}`;
}

function formatPhaseInstruction(steps: readonly Step[], phaseFeedback?: string): string {
  const stepInstructions = steps
    .map((step) => [`Step ${step.number}: ${step.title}`, "", step.body].join("\n"))
    .join("\n\n---\n\n");

  if (phaseFeedback === undefined) return stepInstructions;

  return [stepInstructions, "", "Phase verification feedback:", phaseFeedback].join("\n");
}

/** Map language hint to file extension for sibling discovery. */
function languageExtension(languageHint: string): string {
  switch (languageHint) {
    case "Rust":
      return ".rs";
    case "TypeScript":
      return ".ts";
    case "C++":
      return ".cpp";
    default:
      return ".rs";
  }
}

/**
 * Build a baseline context that includes relevant file contents and git diff.
 *
 * This is supplied on every attempt (not just attempt-0) and includes:
 *   - Existing source files in the workspace
 *   - Current git diff of the working tree
 *
 * This ensures the model has up-to-date context for computing SEARCH anchors
 * and understanding what has changed so far.
 */
export function buildBaselineContext(workspace: string, languageHint: string): string {
  const ext = languageExtension(languageHint);
  const srcDir = resolve(workspace, "src");

  const parts: string[] = [];

  // Include existing source files
  if (existsSync(srcDir)) {
    const files: string[] = [];
    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(ext)) {
        files.push(join(srcDir, entry.name));
      }
    }

    if (files.length > 0) {
      const fileParts: string[] = [];
      for (const file of files) {
        const relPath = relative(workspace, file);
        const content = readFileSync(file, "utf8");
        fileParts.push(`// ${relPath}\n${content}`);
      }
      if (fileParts.length > 0) {
        parts.push("Existing project files:\n\n" + fileParts.join("\n\n---\n\n"));
      }
    }
  }

  // Include current git diff
  try {
    const gitDiff = execSync("git diff", { cwd: workspace, encoding: "utf8" });
    if (gitDiff.trim()) {
      parts.push("Current git diff:\n\n" + gitDiff);
    }
  } catch {
    // git diff failed; continue without it
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : "";
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
  workspace: string,
  implementation: string,
): Promise<Result<void>> {
  // Parse the implementation as aider-style patches
  const parseResult = parsePatch(implementation);
  if (!parseResult.ok) {
    return {
      ok: false,
      error: new Error(`Failed to parse patches: ${parseResult.error.message}`),
    };
  }

  // Apply the patches to the workspace
  const applyResult = await applyPatch(workspace, parseResult.value);
  if (!applyResult.ok) {
    return {
      ok: false,
      error: new Error(
        `Failed to apply patch to "${applyResult.error.filePath}": ${applyResult.error.message}`,
      ),
    };
  }

  return { ok: true, value: undefined };
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

  const writeResult = await writeImplementation(options.workspace, implementResult.value);
  if (!writeResult.ok) return writeResult;

  return { ok: true, value: implementResult.value };
}

async function implementAllPhaseSteps(
  ctx: PipelineContext<AIRequestEvent>,
  options: VerifiedImplementStepOptions,
  steps: readonly Step[],
  baselineContext?: string,
): Promise<Result<string>> {
  const implementations: string[] = [];
  for (const step of steps) {
    const prompt = buildImplementationPrompt(options.languageConfig, step.body, baselineContext);
    const result = await implementAndWrite(ctx, options, prompt, "edit");
    if (!result.ok) return result;
    implementations.push(result.value);
  }
  return { ok: true, value: implementations.join("\n\n") };
}

/**
 * Read the current on-disk content of all source files in the workspace.
 * Used to refresh file contents on each retry so the model can compute
 * SEARCH anchors against the present state.
 */
function readCurrentFileContents(workspace: string, languageHint: string): string {
  const ext = languageExtension(languageHint);
  const srcDir = resolve(workspace, "src");

  if (!existsSync(srcDir)) return "";

  const files: string[] = [];
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(join(srcDir, entry.name));
    }
  }

  if (files.length === 0) return "";

  const parts: string[] = [];
  for (const file of files) {
    const relPath = relative(workspace, file);
    const content = readFileSync(file, "utf8");
    parts.push(`// ${relPath}\n${content}`);
  }

  return `Current file contents:\n\n${parts.join("\n\n---\n\n")}`;
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
      const baselineContext = buildBaselineContext(
        options.workspace,
        options.languageConfig.languageHint,
      );
      let prompt = baselineContext
        ? buildImplementationPrompt(options.languageConfig, originalInstruction, baselineContext)
        : originalInstruction;
      let implementation = "";
      let lastError: Error | undefined;
      let attemptNumber = 0;

      const totalImplementerAttempts = 1 + maxLocalRetries;
      for (; attemptNumber < totalImplementerAttempts; attemptNumber++) {
        const implementResult =
          phaseSteps === undefined
            ? await implementAndWrite(ctx, options, prompt, "edit")
            : attemptNumber === 0
              ? await implementAllPhaseSteps(ctx, options, phaseSteps, baselineContext)
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
        // Refresh current file contents on each retry for accurate SEARCH anchor matching
        const currentFileContents = readCurrentFileContents(
          options.workspace,
          options.languageConfig.languageHint,
        );
        prompt = buildVerificationFailurePrompt(
          phaseSteps === undefined ? originalInstruction : formatPhaseInstruction(phaseSteps),
          implementation,
          lastError.message,
          currentFileContents,
        );
      }

      for (
        let escalationAttempt = 0;
        escalationAttempt < maxEscalationRetries;
        escalationAttempt++
      ) {
        // Refresh current file contents before escalation attempt
        const currentFileContents = readCurrentFileContents(
          options.workspace,
          options.languageConfig.languageHint,
        );
        const fixPrompt = buildVerificationFailurePrompt(
          phaseSteps === undefined ? originalInstruction : formatPhaseInstruction(phaseSteps),
          implementation,
          lastError?.message ?? "Verification failed without diagnostics",
          currentFileContents,
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
