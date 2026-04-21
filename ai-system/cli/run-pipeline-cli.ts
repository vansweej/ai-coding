import { runPipeline } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import { loadConfig } from "./load-config";
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

/* v8 ignore start */
async function main(): Promise<void> {
  const argsResult = parseArgs(process.argv.slice(2));
  if (!argsResult.ok) {
    console.error(`Error: ${argsResult.error.message}`);
    process.exit(1);
  }
  const { pipelineName, workspace, input } = argsResult.value;

  const configResult = loadConfig();
  if (!configResult.ok) {
    console.error(`Error: ${configResult.error.message}`);
    process.exit(1);
  }

  const pipelineResult = selectPipeline(pipelineName, configResult.value, workspace);
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
