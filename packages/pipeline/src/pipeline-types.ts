/** Discriminated result type for operations that can fail predictably. */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/** Output produced by a single pipeline step. */
export interface StepResult {
  readonly stepName: string;
  readonly output: string;
  readonly durationMs: number;
}

/**
 * Shared state threaded through all pipeline steps.
 * TEvent is the originating request type -- can be any shape the caller defines.
 * The results map is intentionally mutable so each step can write its output
 * for subsequent steps to read.
 */
export interface PipelineContext<TEvent = unknown> {
  readonly event: TEvent;
  readonly results: Map<string, StepResult>;
}

/**
 * A single executable unit of work in a pipeline.
 * TEvent must match the PipelineContext type used by the runner.
 */
export interface PipelineStep<TEvent = unknown> {
  readonly name: string;
  execute(ctx: PipelineContext<TEvent>): Promise<Result<StepResult>>;
}

/** Final outcome returned after all pipeline steps complete successfully. */
export interface PipelineOutcome {
  readonly steps: readonly StepResult[];
  readonly totalDurationMs: number;
}
