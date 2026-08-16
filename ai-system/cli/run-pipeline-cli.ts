import { readFileSync } from "node:fs";

import { runPipeline } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import { $ } from "bun";

import { mintRunId } from "../../src/run/run-id";
import { resolvePlanRef } from "../core/orchestrator/cerebrum-plan-source";
import { DevShellPaletteError, runFeature } from "../core/pipeline/feature-runner";
import { BaselineCheckError } from "../core/pipeline/phase-runner";
import { parsePlanFile } from "../core/pipeline/plan-parser";
import type { OnProgress } from "../core/pipeline/progress";
import { buildTheme, formatProgressEvent } from "../core/pipeline/progress";
import { loadConfig } from "./load-config";
import { parseArgs } from "./parse-args";
import { reportParseOnly } from "./parse-only";
import { selectPipeline } from "./select-pipeline";

const PREVIEW_MAX_CHARS = 200;

function isPlanCycle(name: string): boolean {
  return name === "plan-cycle";
}

function previewOutput(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= PREVIEW_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, PREVIEW_MAX_CHARS)}…`;
}

function buildEvent(input: string): AIRequestEvent {
  return {
    id: `cli-${Date.now()}`,
    timestamp: Date.now(),
    source: "cli",
    modeHint: "agentic",
    action: "task",
    payload: { input: input || undefined },
  };
}

function buildSingleStepPlan(input: string): string {
  return [
    "# Feature: CLI input request",
    "",
    "## Phase 1: Implement request",
    "",
    "Commit message: feat: implement CLI request",
    "",
    "### Step 1: Implement request",
    "",
    input,
    "",
  ].join("\n");
}

/**
 * Get the current git branch name.
 *
 * @param workspace - The workspace directory
 * @returns The branch name, or undefined if unable to determine
 */
async function getCurrentBranch(workspace: string): Promise<string | undefined> {
  try {
    const result = await $`git rev-parse --abbrev-ref HEAD`.cwd(workspace).text();
    return result.trim();
  } catch {
    return undefined;
  }
}

/**
 * Check if the current branch is a protected branch (main, master, develop, etc.).
 *
 * @param branch - The branch name to check
 * @returns true if the branch is protected, false otherwise
 */
function isProtectedBranch(branch: string): boolean {
  const protectedBranches = ["main", "master", "develop", "development"];
  return protectedBranches.includes(branch.toLowerCase());
}

/**
 * Exit code contract for plan-cycle:
 *   - 0: all phases pass
 *   - 2: aborted-but-resumable failure (phase exhausted repair budget)
 *   - 3: input/environment errors (bad plan file, wrong branch, missing toolchain)
 */
const EXIT_CODES = {
  SUCCESS: 0,
  RESUMABLE_FAILURE: 2,
  ENVIRONMENT_ERROR: 3,
  DEGRADED: 4,
} as const;

/**
 * Build a diagnostic message and exit code for a failed `runFeature` result.
 *
 * INVARIANT: `message` is always non-null so pre-progress failures cannot be
 * swallowed. The `verbose` flag may enrich the message with additional
 * detail (e.g. stack trace) but MUST NOT gate whether a message is produced.
 *
 * @param error   - The error from a failed `runFeature` result.
 * @param verbose - Whether to enrich the message with additional detail.
 */
export function reportFeatureFailure(
  error: Error,
  verbose: boolean,
): { message: string; exitCode: number } {
  const isEnvironmentError =
    error instanceof DevShellPaletteError || error instanceof BaselineCheckError;
  const exitCode = isEnvironmentError ? EXIT_CODES.ENVIRONMENT_ERROR : EXIT_CODES.RESUMABLE_FAILURE;

  const base = `Feature failed: ${error.message}`;
  const message = verbose && error.stack ? `${base}\n${error.stack}` : base;

  return { message, exitCode };
}

/* v8 ignore start */
async function main(): Promise<void> {
  const argsResult = parseArgs(process.argv.slice(2));
  if (!argsResult.ok) {
    console.error(`Error: ${argsResult.error.message}`);
    process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
  }
  const {
    pipelineName,
    workspace,
    input,
    planPath,
    planRef,
    maxRetries,
    profileName,
    verbose,
    parseOnly,
    strict,
  } = argsResult.value;

  if (argsResult.value.doctor) {
    const { runDoctorSandboxed } = await import("./doctor");
    const doctorResult = await runDoctorSandboxed();
    if (!doctorResult.ok) {
      for (const failure of doctorResult.failures) {
        console.error(`[fail] ${failure.specifier}: ${failure.message}`);
      }
      process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
    }
    console.log("doctor: all checks passed");
    process.exit(EXIT_CODES.SUCCESS);
  }

  const configResult = await loadConfig(profileName, undefined, strict);
  if (!configResult.ok) {
    console.error(`Error: ${configResult.error.message}`);
    process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
  }

  // Enforce isolated run branch for plan-cycle pipelines
  if (isPlanCycle(pipelineName)) {
    const currentBranch = await getCurrentBranch(workspace);
    if (currentBranch === undefined) {
      console.error("Error: unable to determine current git branch");
      process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
    }
    if (isProtectedBranch(currentBranch)) {
      console.error(
        `Error: plan-cycle must run on a dedicated feature branch, not "${currentBranch}"`,
      );
      process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
    }
    // Guard: plan-cycle requires --plan, --plan-ref, or --input
    if (planPath === undefined && planRef === undefined && input === "") {
      console.error('Error: plan-cycle requires --plan <file>, --plan-ref <id>, or --input "..."');
      process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
    }
  }

  if (
    isPlanCycle(pipelineName) &&
    (planPath !== undefined || planRef !== undefined || input !== "")
  ) {
    let planContent: string;
    if (planRef !== undefined) {
      const resolved = await resolvePlanRef(planRef, {
        cerebrumBin: process.env.CEREBRUM_BIN ?? "",
      });
      if (!resolved.ok) {
        console.error(`Error: ${resolved.error.message}`);
        process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
      }
      planContent = resolved.value;
    } else if (planPath !== undefined) {
      planContent = readFileSync(planPath, "utf8");
    } else {
      planContent = buildSingleStepPlan(input);
    }

    if (parseOnly) {
      const parseResult = parsePlanFile(planContent);
      const { output, exitCode } = reportParseOnly(parseResult);
      console.log(output);
      process.exit(exitCode);
    }

    let onProgress: OnProgress | undefined;
    if (verbose) {
      const useColor =
        !process.env.NO_COLOR && (process.env.FORCE_COLOR === "1" || process.stderr.isTTY === true);
      const theme = buildTheme(useColor);
      onProgress = (event) => console.error(formatProgressEvent(event, theme));
    }

    const runId = mintRunId();

    const outcome = await runFeature(planContent, {
      config: configResult.value,
      workspace,
      planPath,
      runId,
      retryConfig: { maxLocalRetries: maxRetries },
      onProgress,
    });

    if (!outcome.ok) {
      const { message, exitCode } = reportFeatureFailure(outcome.error, verbose);
      console.error(message);
      process.exit(exitCode);
      return;
    }

    console.log(`Running feature: ${outcome.value.feature}`);
    console.log(`Workspace:       ${workspace}`);
    for (const phase of outcome.value.phases) {
      console.log(`[ok] Phase ${phase.phaseNumber}: ${phase.commitMessage}`);
    }

    const degradations: string[] = [];
    if (degradations.length > 0) {
      for (const warn of degradations) {
        console.warn(`WARN: ${warn}`);
      }
      process.exit(EXIT_CODES.DEGRADED);
    }
    process.exit(EXIT_CODES.SUCCESS);
  }

  const pipelineResult = await selectPipeline(pipelineName, configResult.value, workspace);
  if (!pipelineResult.ok) {
    console.error(`Error: ${pipelineResult.error.message}`);
    process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
  }

  const event = buildEvent(input);

  console.log(`Running pipeline: ${pipelineName}`);
  console.log(`Workspace:        ${workspace}`);
  if (input) console.log(`Input:            ${input}`);
  console.log("");

  const outcome = await runPipeline(pipelineResult.value, event);

  if (!outcome.ok) {
    console.error(`Pipeline failed: ${outcome.error.message}`);
    process.exit(EXIT_CODES.RESUMABLE_FAILURE);
  }

  for (const step of outcome.value.steps) {
    const duration = `${step.durationMs}ms`;
    const preview = previewOutput(step.output);
    console.log(`[ok] ${step.stepName.padEnd(20)} ${duration.padStart(8)}  ${preview}`);
  }

  console.log("");
  console.log(`Done in ${outcome.value.totalDurationMs}ms.`);
  process.exit(EXIT_CODES.SUCCESS);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Unexpected error: ${message}`);
    process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
  });
}
/* v8 ignore stop */
