import type { AIRequestEvent, Result } from "@ai-coding/shared";

import type { PipelineContext, PipelineOutcome, PipelineStep, StepResult } from "./pipeline-types";

/**
 * Run a linear pipeline of steps, threading a shared context through each one.
 * Execution stops immediately on the first step failure (early exit).
 *
 * @param steps - Ordered list of steps to execute.
 * @param event - The originating AI request event passed into the pipeline context.
 * @returns A Result containing the full outcome on success, or the first error on failure.
 */
export async function runPipeline(
  steps: readonly PipelineStep[],
  event: AIRequestEvent,
): Promise<Result<PipelineOutcome>> {
  if (steps.length === 0) {
    return { ok: false, error: new Error("Pipeline has no steps") };
  }

  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.name)) {
      return { ok: false, error: new Error(`Duplicate step name: "${step.name}"`) };
    }
    seen.add(step.name);
  }

  const startedAt = Date.now();
  const ctx: PipelineContext = { event, results: new Map<string, StepResult>() };
  const completed: StepResult[] = [];

  for (const step of steps) {
    const result = await step.execute(ctx);
    if (!result.ok) {
      return result;
    }
    ctx.results.set(step.name, result.value);
    completed.push(result.value);
  }

  return {
    ok: true,
    value: {
      steps: completed,
      totalDurationMs: Date.now() - startedAt,
    },
  };
}
