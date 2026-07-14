import type { PipelineStep, Result } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import { PIPELINE_REGISTRY } from "../config/pipeline-registry";
import type { OrchestratorConfig } from "../core/orchestrator/orchestrate";
import { DOC_CYCLE_SKETCH } from "../core/pipeline/definitions/doc-cycle";
import { createCppScaffoldPipeline } from "../core/pipeline/definitions/scaffold-cpp";
import { createRustScaffoldPipeline } from "../core/pipeline/definitions/scaffold-rust";

/** All pipeline names accepted by the CLI. */
export type PipelineName = "doc-cycle" | "scaffold-rust" | "scaffold-cpp";

/**
 * Select and instantiate a pipeline by name.
 *
 * @param name      - Pipeline name from the CLI argument.
 * @param config    - Orchestrator config with wired dispatchers.
 * @param workspace - Workspace path passed to the pipeline factory.
 */
export async function selectPipeline(
  name: string,
  config: OrchestratorConfig,
  workspace: string,
): Promise<Result<readonly PipelineStep<AIRequestEvent>[]>> {
  switch (name) {
    case "doc-cycle":
      return {
        ok: false,
        error: new Error(
          `Pipeline "doc-cycle" is deferred. Planned steps: ${DOC_CYCLE_SKETCH.steps.join(" → ")}`,
        ),
      };
    case "scaffold-rust":
      return { ok: true, value: createRustScaffoldPipeline(config, workspace) };
    case "scaffold-cpp":
      return { ok: true, value: createCppScaffoldPipeline(config, workspace) };
    default: {
      const known = PIPELINE_REGISTRY.map((entry) => entry.name).join(", ");
      return {
        ok: false,
        error: new Error(`Unknown pipeline: "${name}". Known pipelines: ${known}`),
      };
    }
  }
}
