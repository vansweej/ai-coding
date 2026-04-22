import type { PipelineStep, Result } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import { PIPELINE_REGISTRY } from "../config/pipeline-registry";
import type { OrchestratorConfig } from "../core/orchestrator/orchestrate";
import { createCMakeDevCyclePipeline } from "../core/pipeline/definitions/cmake-dev-cycle";
import { createDevCyclePipeline } from "../core/pipeline/definitions/dev-cycle";
import { createRustDevCyclePipeline } from "../core/pipeline/definitions/rust-dev-cycle";
import { createCppScaffoldPipeline } from "../core/pipeline/definitions/scaffold-cpp";
import { createRustScaffoldPipeline } from "../core/pipeline/definitions/scaffold-rust";

/** All pipeline names accepted by the CLI. */
export type PipelineName =
  | "dev-cycle"
  | "rust-dev-cycle"
  | "cmake-dev-cycle"
  | "scaffold-rust"
  | "scaffold-cpp";

/**
 * Select and instantiate a pipeline by name.
 *
 * @param name      - Pipeline name from the CLI argument.
 * @param config    - Orchestrator config with wired dispatchers.
 * @param workspace - Workspace path passed to the pipeline factory.
 */
export function selectPipeline(
  name: string,
  config: OrchestratorConfig,
  workspace: string,
): Result<readonly PipelineStep<AIRequestEvent>[]> {
  switch (name) {
    case "dev-cycle":
      return { ok: true, value: createDevCyclePipeline(config, workspace) };
    case "rust-dev-cycle":
      return { ok: true, value: createRustDevCyclePipeline(config, workspace) };
    case "cmake-dev-cycle":
      return { ok: true, value: createCMakeDevCyclePipeline(config, workspace) };
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
