import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { PipelineContext, PipelineStep, Result, StepResult } from "@ai-coding/pipeline";
import type { AIAction, AIRequestEvent } from "@ai-coding/shared";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { orchestrate } from "../../orchestrator/orchestrate";
import type { DevCycleLanguageConfig } from "../definitions/language-configs";
import type { CoverageDirective, Step } from "../plan-parser";
import type { OnProgress } from "../progress";
import {
  composeImplementSystem,
  paletteExtensions,
  paletteLanguageHint,
  runUnionVerification,
} from "../routing/route";
import { applyPatch } from "./apply-patch-step";
import { parsePatch, stripEnclosingFence } from "./parse-patch";

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
  /**
   * Legacy single-language configuration. Required unless `palette` is
   * provided. When both are supplied, `palette` takes precedence -- see
   * {@link buildPaletteLanguageConfig}.
   */
  readonly languageConfig?: DevCycleLanguageConfig;
  /**
   * Set of tool names detected as available in the workspace's devShell
   * (see `devShellPalette` in `@ai-coding/pipeline`). When provided, the
   * step routes per-file rather than using a single fixed `languageConfig`:
   * context discovery and the implement prompt are composed from every
   * available toolchain (see `paletteExtensions`/`composeImplementSystem`),
   * and verification is the deduped-by-step-name union of toolchains
   * routed from the files actually touched (see `runUnionVerification`).
   */
  readonly palette?: ReadonlySet<string>;
  /**
   * The phase's `Coverage:` directive, used only alongside `palette` --
   * threaded through to `runUnionVerification` so a routed Rust file gates
   * its tarpaulin/coverage steps on the SAME directive the legacy
   * `factory(coverage, diff)` path used to consult. Ignored when
   * `languageConfig` is supplied directly (the legacy path already baked
   * its own coverage directive in at construction time).
   */
  readonly coverage?: CoverageDirective;
  /**
   * Current git diff, used only alongside `palette` for the same
   * coverage-auto-exemption purpose `resolveCoverageThreshold` has always
   * served. Ignored when `languageConfig` is supplied directly.
   */
  readonly diff?: string;
  readonly steps?: readonly Step[];
  readonly retryConfig?: RetryConfig;
  /** Phase number this step belongs to, used to tag emitted progress events. */
  readonly phaseNumber?: number;
  /** Optional progress reporter; silent when omitted. */
  readonly onProgress?: OnProgress;
}

/**
 * `VerifiedImplementStepOptions` with `languageConfig` narrowed to always be
 * present. Internal helper functions operate on this resolved shape so they
 * never need to re-check which of `languageConfig`/`palette` was supplied --
 * that resolution happens exactly once, at the top of `execute`.
 */
type ResolvedVerifiedImplementStepOptions = VerifiedImplementStepOptions & {
  readonly languageConfig: DevCycleLanguageConfig;
};

/**
 * Builds a synthetic `DevCycleLanguageConfig` from a devShell palette,
 * satisfying the exact same shape `createVerifiedImplementStep`'s internals
 * already consume (`implementSystem`, `languageHint`, `sourceExtensions`,
 * `sourceRoots`, `toolchainSteps`) -- so every existing code path (prompt
 * building, context discovery, verification execution, retry/escalation
 * logic) works completely UNCHANGED whether it's driven by a fixed
 * `languageConfig` or this palette-derived composite.
 *
 * `toolchainSteps` here is per-file-routed union verification
 * (`runUnionVerification`), not a single toolchain's fixed steps -- so it is
 * intentionally recomputed on every call (each retry re-reads the current
 * git diff, which is correct: verification should reflect whatever the
 * latest attempt actually touched).
 *
 * `name` is a required field on `DevCycleLanguageConfig` but is never read
 * anywhere in this file -- `"typescript"` is used as an inert sentinel.
 */
export function buildPaletteLanguageConfig(
  workspace: string,
  palette: ReadonlySet<string>,
  coverage?: CoverageDirective,
  diff?: string,
): DevCycleLanguageConfig {
  return {
    name: "typescript",
    languageHint: paletteLanguageHint(palette),
    implementSystem: composeImplementSystem(palette),
    sourceExtensions: paletteExtensions(palette),
    sourceRoots: ["."],
    toolchainSteps: (ws: string) => runUnionVerification(ws, palette, coverage, diff),
  };
}

/**
 * Describes which attempt of the phase's overall retry budget is currently
 * running, so per-step progress events can report an honest `index/max`
 * against the phase-level budget rather than inventing a per-step counter.
 */
interface AttemptInfo {
  /** Whether this attempt belongs to the local-retry loop or the escalation loop. */
  readonly kind: "local" | "escalation";
  /** Attempt index within its loop. 0 means "first pass" (not a retry). */
  readonly index: number;
  /** The loop's total attempt budget (maxLocalRetries or maxEscalationRetries). */
  readonly max: number;
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
  options: ResolvedVerifiedImplementStepOptions,
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
  // Parse the implementation as aider-style patches. Tolerate a single
  // enclosing code fence (e.g. ```bash ... ```) that some models wrap their
  // output in -- stripping it here keeps parsePatch's grammar strict while
  // absorbing this common weak-model failure mode before it reaches parsing.
  const parseResult = parsePatch(stripEnclosingFence(implementation));
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
  options: ResolvedVerifiedImplementStepOptions,
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
  options: ResolvedVerifiedImplementStepOptions,
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

/** Outcome of attempting a run of phase steps starting at a given index. */
type PhaseStepsOutcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: Error; readonly failedAtIndex: number };

/**
 * Implement phase steps starting at `startIndex`, using `buildStepPrompt` to
 * construct each step's prompt.
 *
 * On failure, reports the index of the failing step so the caller can retry
 * from exactly that step rather than re-sending already-applied steps. This
 * matters because a multi-step phase applies each step's patch immediately
 * as it succeeds: if a LATER step fails, re-sending ALL steps (including
 * ones already correctly applied) confuses the model -- having just been
 * shown that steps 1..N-1 are already present in the current file contents,
 * it tends to report "everything is already implemented" in prose instead
 * of fixing the one step that actually failed.
 */
async function implementPhaseSteps(
  ctx: PipelineContext<AIRequestEvent>,
  options: ResolvedVerifiedImplementStepOptions,
  steps: readonly Step[],
  startIndex: number,
  buildStepPrompt: (step: Step) => string,
  attempt: AttemptInfo,
  action: AIAction = "edit",
): Promise<PhaseStepsOutcome> {
  const phase = options.phaseNumber ?? 0;
  const implementations: string[] = [];
  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i] as Step;

    if (attempt.index > 0 && i === startIndex) {
      options.onProgress?.({
        kind: "step-retry",
        phase,
        step: step.number,
        index: attempt.index,
        max: attempt.max,
        retry: attempt.kind,
      });
    } else {
      options.onProgress?.({ kind: "step-start", phase, step: step.number, title: step.title });
    }

    const result = await implementAndWrite(ctx, options, buildStepPrompt(step), action);
    if (!result.ok) {
      options.onProgress?.({
        kind: "step-fail",
        phase,
        step: step.number,
        reason: result.error.message,
      });
      return { ok: false, error: result.error, failedAtIndex: i };
    }
    options.onProgress?.({ kind: "step-finish", phase, step: step.number });
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
  baseOptions: VerifiedImplementStepOptions,
): PipelineStep<AIRequestEvent> {
  const maxLocalRetries = baseOptions.retryConfig?.maxLocalRetries ?? 3;
  const maxEscalationRetries = baseOptions.retryConfig?.maxEscalationRetries ?? 1;

  return {
    name,
    execute: async (ctx: PipelineContext<AIRequestEvent>): Promise<Result<StepResult>> => {
      const startedAt = Date.now();

      // Resolve the effective languageConfig ONCE, up front: when a devShell
      // `palette` is supplied it takes precedence and is composed into a
      // synthetic DevCycleLanguageConfig (see buildPaletteLanguageConfig) so
      // every line below -- prompt building, context discovery, verification,
      // retry/escalation -- runs completely UNCHANGED regardless of which
      // path produced `options.languageConfig`. Falls back to the legacy
      // fixed `languageConfig` when no palette is given (existing callers
      // are entirely unaffected by this branch).
      let languageConfig: DevCycleLanguageConfig;
      if (baseOptions.palette) {
        languageConfig = buildPaletteLanguageConfig(
          baseOptions.workspace,
          baseOptions.palette,
          baseOptions.coverage,
          baseOptions.diff,
        );
      } else if (baseOptions.languageConfig) {
        languageConfig = baseOptions.languageConfig;
      } else {
        return {
          ok: false,
          error: new Error(
            `Verified implement step "${name}" requires either "languageConfig" or "palette" in its options`,
          ),
        };
      }
      const options: ResolvedVerifiedImplementStepOptions = { ...baseOptions, languageConfig };

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
      // Only meaningful when phaseSteps is defined. Tracks how many of the
      // phase's steps have been successfully applied so far (0..steps.length).
      // A value less than steps.length means a retry should resume from
      // exactly that step rather than re-sending already-applied steps.
      let stepCursor = 0;

      const totalImplementerAttempts = 1 + maxLocalRetries;
      for (; attemptNumber < totalImplementerAttempts; attemptNumber++) {
        let implementResult: Result<string>;

        if (phaseSteps === undefined) {
          implementResult =
            attemptNumber === 0
              ? await implementAndWrite(ctx, options, prompt, "edit")
              : await implementAndWrite(
                  ctx,
                  options,
                  buildImplementationPrompt(options.languageConfig, prompt),
                  "edit",
                );
        } else if (attemptNumber === 0) {
          const phaseResult = await implementPhaseSteps(
            ctx,
            options,
            phaseSteps,
            0,
            (step) => buildImplementationPrompt(options.languageConfig, step.body, baselineContext),
            { kind: "local", index: 0, max: maxLocalRetries },
          );
          if (phaseResult.ok) {
            stepCursor = phaseSteps.length;
            implementResult = phaseResult;
          } else {
            stepCursor = phaseResult.failedAtIndex;
            implementResult = phaseResult;
          }
        } else if (stepCursor < phaseSteps.length) {
          // Recovering from a step-level implement failure (not a
          // verification failure): retry ONLY the remaining steps, starting
          // at the one that failed, with the error and refreshed file
          // contents attached to that step's own instruction. Re-sending
          // already-applied steps here is what caused the model to
          // (incorrectly) report "everything is already implemented"
          // instead of fixing the one step that actually failed.
          const currentFileContents = readCurrentFileContents(
            options.workspace,
            options.languageConfig,
          );
          const errorMessage = lastError?.message ?? "Implementation failed without diagnostics";
          const phaseResult = await implementPhaseSteps(
            ctx,
            options,
            phaseSteps,
            stepCursor,
            (step) =>
              buildImplementationPrompt(
                options.languageConfig,
                buildVerificationFailurePrompt(
                  formatPhaseInstruction([step]),
                  "",
                  errorMessage,
                  currentFileContents,
                ),
              ),
            { kind: "local", index: attemptNumber, max: maxLocalRetries },
          );
          if (phaseResult.ok) {
            stepCursor = phaseSteps.length;
            implementResult = phaseResult;
          } else {
            stepCursor = phaseResult.failedAtIndex;
            implementResult = phaseResult;
          }
        } else {
          // All phase steps have been successfully applied at least once;
          // this retry is recovering from a VERIFICATION failure (not an
          // implement-level failure), so fall back to the full combined
          // instruction plus error -- a cross-step issue may require
          // revisiting any of the already-applied steps.
          options.onProgress?.({
            kind: "phase-attempt",
            phase: options.phaseNumber ?? 0,
            retry: "local",
            index: attemptNumber,
            max: maxLocalRetries,
          });
          implementResult = await implementAndWrite(
            ctx,
            options,
            buildImplementationPrompt(options.languageConfig, prompt),
            "edit",
          );
        }

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
          //
          // If a PRIOR attempt in this run already wrote a successful
          // implementation (implementation !== ""), re-verify the CURRENT
          // (unchanged) tree before giving up: the model may be correctly
          // reporting that no further code changes are needed (e.g.
          // "already implemented"), in which case that prior write already
          // left the tree in a passing state and verification simply
          // hadn't been re-run since (it only runs after a successful
          // implement). Guarded on a prior successful write specifically
          // so this can never fire on a cold, never-implemented tree --
          // otherwise a baseline that happens to already pass its own
          // toolchain (e.g. existing tests unrelated to the new feature)
          // could cause a false "verified" result with nothing implemented.
          if (implementation !== "") {
            const recheck = await runVerification(ctx, verificationSteps);
            if (recheck.ok) {
              return {
                ok: true,
                value: {
                  stepName: name,
                  output: `Verified implementation after ${attemptNumber + 1} local attempt(s) (model reported no further changes needed; re-verified current state)`,
                  durationMs: Date.now() - startedAt,
                },
              };
            }
          }
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
        const errorMessage = lastError?.message ?? "Verification failed without diagnostics";

        let fixResult: Result<string>;

        if (phaseSteps !== undefined && stepCursor < phaseSteps.length) {
          // Local retries were exhausted while a specific step still hadn't
          // been successfully applied. Escalate on ONLY that remaining step
          // (same reasoning as the local loop above), rather than re-sending
          // already-applied steps.
          const phaseResult = await implementPhaseSteps(
            ctx,
            options,
            phaseSteps,
            stepCursor,
            (step) =>
              buildImplementationPrompt(
                options.languageConfig,
                buildVerificationFailurePrompt(
                  formatPhaseInstruction([step]),
                  "",
                  errorMessage,
                  currentFileContents,
                ),
              ),
            { kind: "escalation", index: escalationAttempt + 1, max: maxEscalationRetries },
            "fix",
          );
          if (phaseResult.ok) {
            stepCursor = phaseSteps.length;
            fixResult = phaseResult;
          } else {
            stepCursor = phaseResult.failedAtIndex;
            fixResult = phaseResult;
          }
        } else {
          const fixPrompt = buildVerificationFailurePrompt(
            phaseSteps === undefined ? originalInstruction : formatPhaseInstruction(phaseSteps),
            implementation,
            errorMessage,
            currentFileContents,
          );
          options.onProgress?.({
            kind: "phase-attempt",
            phase: options.phaseNumber ?? 0,
            retry: "escalation",
            index: escalationAttempt + 1,
            max: maxEscalationRetries,
          });
          fixResult = await implementAndWrite(
            ctx,
            options,
            buildImplementationPrompt(options.languageConfig, fixPrompt),
            "fix",
          );
        }

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
          // during escalation is retryable, not fatal. Also, if a PRIOR
          // attempt already wrote a successful implementation, re-verify
          // the current (unchanged) state before giving up -- the model
          // may be correctly reporting that no further changes are needed.
          // Guarded on a prior successful write for the same reason as the
          // local loop: never let a cold, never-implemented tree pass by
          // coincidence of its own baseline already satisfying the
          // toolchain.
          if (implementation !== "") {
            const recheck = await runVerification(ctx, verificationSteps);
            if (recheck.ok) {
              return {
                ok: true,
                value: {
                  stepName: name,
                  output: `Verified implementation after escalation attempt ${escalationAttempt + 1} (model reported no further changes needed; re-verified current state)`,
                  durationMs: Date.now() - startedAt,
                },
              };
            }
          }
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
