import type { AIRequestEvent, Result } from "@ai-coding/shared";

/** Output produced by a single pipeline step. */
export interface StepResult {
  readonly stepName: string;
  readonly output: string;
  readonly durationMs: number;
}

/**
 * Shared state threaded through all pipeline steps.
 * The context itself is readonly at the property level; results is intentionally
 * mutable so that each step can write its output for subsequent steps to read.
 */
export interface PipelineContext {
  readonly event: AIRequestEvent;
  readonly results: Map<string, StepResult>;
}

/** A single executable unit of work in a pipeline. */
export interface PipelineStep {
  readonly name: string;
  execute(ctx: PipelineContext): Promise<Result<StepResult>>;
}

/** Final outcome returned after all pipeline steps complete successfully. */
export interface PipelineOutcome {
  readonly steps: readonly StepResult[];
  readonly totalDurationMs: number;
}
