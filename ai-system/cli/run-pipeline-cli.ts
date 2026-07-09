import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runPipeline } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import {
  CPP_CONFIG,
  DEV_CYCLE_LANGUAGE_CONFIGS,
  RUST_CONFIG,
  TYPESCRIPT_CONFIG,
} from "../core/pipeline/definitions/language-configs";
import type { DevCycleLanguageConfig } from "../core/pipeline/definitions/language-configs";
import { runFeature } from "../core/pipeline/feature-runner";
import { loadConfig } from "./load-config";
import type { CliLanguage } from "./parse-args";
import { parseArgs } from "./parse-args";
import { selectPipeline } from "./select-pipeline";

const PREVIEW_MAX_CHARS = 200;

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

function detectLanguage(workspace: string, override?: CliLanguage): DevCycleLanguageConfig {
  if (override !== undefined) return DEV_CYCLE_LANGUAGE_CONFIGS[override];
  if (existsSync(join(workspace, "Cargo.toml"))) return RUST_CONFIG;
  if (existsSync(join(workspace, "CMakeLists.txt"))) return CPP_CONFIG;
  return TYPESCRIPT_CONFIG;
}

function languageForPipeline(
  pipelineName: string,
  workspace: string,
  override?: CliLanguage,
): DevCycleLanguageConfig {
  if (pipelineName === "rust-dev-cycle") return RUST_CONFIG;
  if (pipelineName === "cmake-dev-cycle") return CPP_CONFIG;
  return detectLanguage(workspace, override);
}

function isDevCyclePipeline(pipelineName: string): boolean {
  return (
    pipelineName === "dev-cycle" ||
    pipelineName === "rust-dev-cycle" ||
    pipelineName === "cmake-dev-cycle"
  );
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

/* v8 ignore start */
async function main(): Promise<void> {
  const argsResult = parseArgs(process.argv.slice(2));
  if (!argsResult.ok) {
    console.error(`Error: ${argsResult.error.message}`);
    process.exit(1);
  }
  const { pipelineName, workspace, input, planPath, language, maxRetries, profileName } =
    argsResult.value;

  const configResult = await loadConfig(profileName);
  if (!configResult.ok) {
    console.error(`Error: ${configResult.error.message}`);
    process.exit(1);
  }

  const languageConfig = languageForPipeline(pipelineName, workspace, language);

  if (isDevCyclePipeline(pipelineName) && (planPath !== undefined || input !== "")) {
    const planContent =
      planPath !== undefined ? readFileSync(planPath, "utf8") : buildSingleStepPlan(input);
    const outcome = await runFeature(planContent, {
      config: configResult.value,
      workspace,
      languageConfig,
      retryConfig: { maxLocalRetries: maxRetries },
    });

    if (!outcome.ok) {
      console.error(`Feature failed: ${outcome.error.message}`);
      process.exit(1);
    }

    console.log(`Running feature: ${outcome.value.feature}`);
    console.log(`Workspace:       ${workspace}`);
    console.log(`Language:        ${languageConfig.name}`);
    for (const phase of outcome.value.phases) {
      console.log(`[ok] Phase ${phase.phaseNumber}: ${phase.commitMessage}`);
    }
    return;
  }

  const pipelineResult = await selectPipeline(pipelineName, configResult.value, workspace);
  if (!pipelineResult.ok) {
    console.error(`Error: ${pipelineResult.error.message}`);
    process.exit(1);
  }

  const event = buildEvent(input);

  console.log(`Running pipeline: ${pipelineName}`);
  console.log(`Workspace:        ${workspace}`);
  if (input) console.log(`Input:            ${input}`);
  console.log("");

  const outcome = await runPipeline(pipelineResult.value, event);

  if (!outcome.ok) {
    console.error(`Pipeline failed: ${outcome.error.message}`);
    process.exit(1);
  }

  for (const step of outcome.value.steps) {
    const duration = `${step.durationMs}ms`;
    const preview = previewOutput(step.output);
    console.log(`[ok] ${step.stepName.padEnd(20)} ${duration.padStart(8)}  ${preview}`);
  }

  console.log("");
  console.log(`Done in ${outcome.value.totalDurationMs}ms.`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Unexpected error: ${message}`);
  process.exit(1);
});
/* v8 ignore stop */
