import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

/** Deferred documentation pipeline shape. */
export interface DocCyclePipelineSketch {
  readonly input: "documentation phase from a structured plan file";
  readonly output: "markdown files under docs/";
  readonly steps: readonly ["read-source", "generate-docs", "write-docs"];
  readonly modelRole: "documenter";
}

/** Placeholder contract for the future doc-cycle pipeline. */
export const DOC_CYCLE_SKETCH: DocCyclePipelineSketch = {
  input: "documentation phase from a structured plan file",
  output: "markdown files under docs/",
  steps: ["read-source", "generate-docs", "write-docs"],
  modelRole: "documenter",
};

/**
 * Create the documentation pipeline.
 *
 * This is intentionally a sketch-only placeholder: `doc-cycle` is registered so
 * callers can discover the planned pipeline, but execution remains deferred.
 */
export function createDocCyclePipeline(): readonly PipelineStep<AIRequestEvent>[] {
  return [];
}
