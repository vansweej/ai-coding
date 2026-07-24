import { readFileSync } from "node:fs";

import { runPipeline } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import { $ } from "bun";

import { PLAN_CONFIG_FACTORIES } from "../core/pipeline/definitions/language-configs";
import { runFeature } from "../core/pipeline/feature-runner";
import { KNOWN_LANGUAGES, type LanguageName } from "../core/pipeline/plan-parser";
import { loadConfig } from "./load-config";
import { parseArgs } from "./parse-args";
import { selectPipeline } from "./select-pipeline";

const PREVIEW_MAX_CHARS = 200;

/** Returns true when the pipeline name is the legacy Rust-specific alias. */
function isRustPlanCycleAlias(name: string): boolean {
  return name === "rust-plan-cycle";
}

/** Returns true for any plan-cycle variant (primary name or alias). */
function isPlanCycle(name: string): boolean {
  return name === "plan-cycle" || name === "rust-plan-cycle";
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
 * Exit code contract for rust-plan-cycle:
 *   - 0: all phases pass
 *   - 2: aborted-but-resumable failure (phase exhausted repair budget)
 *   - 3: input/environment errors (bad plan file, wrong branch, missing toolchain)
 */
const EXIT_CODES = {
  SUCCESS: 0,
  RESUMABLE_FAILURE: 2,
  ENVIRONMENT_ERROR: 3,
} as const;

/* v8 ignore start */
async function main(): Promise<void> {
  const argsResult = parseArgs(process.argv.slice(2));
  if (!argsResult.ok) {
    console.error(`Error: ${argsResult.error.message}`);
    process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
  }
  const { pipelineName, workspace, input, planPath, maxRetries, profileName, language } =
    argsResult.value;

  const configResult = await loadConfig(profileName);
  if (!configResult.ok) {
    console.error(`Error: ${configResult.error.message}`);
    process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
  }

  // Resolve default language: rust-plan-cycle alias always forces rust;
  // otherwise honour --language, falling back to typescript.
  let defaultLanguage: LanguageName;
  if (isRustPlanCycleAlias(pipelineName)) {
    defaultLanguage = "rust";
  } else if (language !== undefined) {
    if (!(KNOWN_LANGUAGES as readonly string[]).includes(language)) {
      console.error(
        `Error: unknown --language value "${language}". Must be one of: ${KNOWN_LANGUAGES.join(", ")}`,
      );
      process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
    }
    defaultLanguage = language as LanguageName;
  } else {
    defaultLanguage = "typescript";
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
    // Guard: plan-cycle requires either --plan or --input
    if (planPath === undefined && input === "") {
      console.error('Error: plan-cycle requires either --plan <file> or --input "..."');
      process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
    }
  }

  if (isPlanCycle(pipelineName) && (planPath !== undefined || input !== "")) {
    const planContent =
      planPath !== undefined ? readFileSync(planPath, "utf8") : buildSingleStepPlan(input);
    const outcome = await runFeature(planContent, {
      config: configResult.value,
      workspace,
      defaultLanguage,
      factories: PLAN_CONFIG_FACTORIES,
      retryConfig: { maxLocalRetries: maxRetries },
    });

    if (!outcome.ok) {
      console.error(`Feature failed: ${outcome.error.message}`);
      // Determine if this is a resumable failure or environment error
      // For now, treat all feature failures as resumable (exit code 2)
      process.exit(EXIT_CODES.RESUMABLE_FAILURE);
    }

    console.log(`Running feature: ${outcome.value.feature}`);
    console.log(`Workspace:       ${workspace}`);
    console.log(`Language:        ${defaultLanguage}`);
    for (const phase of outcome.value.phases) {
      console.log(`[ok] Phase ${phase.phaseNumber}: ${phase.commitMessage}`);
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

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${message}`);
  process.exit(EXIT_CODES.ENVIRONMENT_ERROR);
});
/* v8 ignore stop */
