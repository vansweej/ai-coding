import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { PipelineContext, PipelineStep, Result, StepResult } from "@ai-coding/pipeline";
import type { AIAction, AIRequestEvent } from "@ai-coding/shared";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { orchestrate } from "../../orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "../definitions/language-configs";
import type { Step } from "../plan-parser";
import { applyPatch } from "./apply-patch-step";
import { parsePatch } from "./parse-patch";

const IMPLEMENT_RESULT_NAME = "verified-implement-output";

/** Directories that are always skipped during recursive source discovery. */
const JUNK_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  ".venv",
  "__pycache__",
  "result",
  ".direnv",
  "dist-newstyle",
  ".stack-work",
]);

/** Maximum number of source files collected for context to prevent prompt bloat. */
const MAX_SOURCE_FILES = 100;

/**
 * Recursively discover source files under the given root directories.
 *
 * Skips well-known junk directories and stops once MAX_SOURCE_FILES is reached.
 * Each root is resolved relative to the workspace.
 */
function discoverSourceFiles(
  workspace: string,
  roots: readonly string[],
  exts: readonly string[],
): string[] {
  const extSet = new Set(exts);
  const found: string[] = [];

  for (const root of roots) {
    if (found.length >= MAX_SOURCE_FILES) break;
    const rootAbs = resolve(workspace, root);
    if (!existsSync(rootAbs)) continue;

    const stack: string[] = [rootAbs];
    while (stack.length > 0 && found.length < MAX_SOURCE_FILES) {
      const dir = stack.pop() as string;
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (!JUNK_DIRS.has(entry.name)) {
              stack.push(join(dir, entry.name));
            }
          } else if (entry.isFile()) {
            const dotIndex = entry.name.lastIndexOf(".");
            const ext = dotIndex >= 0 ? entry.name.slice(dotIndex) : "";
            if (extSet.has(ext) && found.length < MAX_SOURCE_FILES) {
              found.push(join(dir, entry.name));
            }
          }
        }
      } catch {
        // Directory unreadable; skip.
      }
    }
  }

  return found;
}

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

/**
 * Build a baseline context that includes relevant file contents and git diff.
 *
 * Uses config-driven recursive source discovery across all declared sourceRoots,
 * skipping junk directories. Supplied on every attempt so the model always has
 * up-to-date context for computing SEARCH anchors.
 */
export function buildBaselineContext(workspace: string, config: DevCycleLanguageConfig): string {
  const roots = config.sourceRoots ?? ["."];
  const files = discoverSourceFiles(workspace, roots, config.sourceExtensions);
  const parts: string[] = [];

  if (files.length > 0) {
    const fileParts: string[] = [];
    for (const file of files) {
      const relPath = relative(workspace, file);
      const content = readFileSync(file, "utf8");
      fileParts.push(`// ${relPath}\n${content}`);
    }
    parts.push(`Existing project files:\n\n${fileParts.join("\n\n---\n\n")}`);
  }

  // Include current git diff
  try {
    const gitDiff = execSync("git diff", { cwd: workspace, encoding: "utf8" });
    if (gitDiff.trim()) {
      parts.push(`Current git diff:\n\n${gitDiff}`);
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
    maxTokens: 8192,
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
function readCurrentFileContents(workspace: string, config: DevCycleLanguageConfig): string {
  const roots = config.sourceRoots ?? ["."];
  const files = discoverSourceFiles(workspace, roots, config.sourceExtensions);

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
      const baselineContext = buildBaselineContext(options.workspace, options.languageConfig);
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

        if (implementResult.ok) {
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
        } else {
          // The model returned prose instead of patches, or a SEARCH anchor
          // did not match the current file contents. This is retryable, not
          // fatal: feed the error back on the next attempt (with refreshed
          // file contents) instead of aborting the whole feature. Without
          // this, a single chatty or malformed response would kill an
          // otherwise-recoverable unattended run.
          lastError = implementResult.error;
        }

        // Refresh current file contents on each retry for accurate SEARCH anchor matching
        const currentFileContents = readCurrentFileContents(
          options.workspace,
          options.languageConfig,
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
          options.languageConfig,
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

        if (fixResult.ok) {
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
        } else {
          // Same reasoning as the local loop above: a parse/apply failure
          // during escalation is retryable, not fatal.
          lastError = fixResult.error;
        }
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
