import type { PipelineStep, Result } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import { FileBackend, createBestBackend } from "@ai-coding/skills";
import type { SkillBackend } from "@ai-coding/skills";

import { PIPELINE_REGISTRY } from "../config/pipeline-registry";
import type { OrchestratorConfig } from "../core/orchestrator/orchestrate";
import { createDevCyclePipeline } from "../core/pipeline/definitions/dev-cycle";
import {
  CPP_CONFIG,
  RUST_CONFIG,
  TYPESCRIPT_CONFIG,
} from "../core/pipeline/definitions/language-configs";
import { createCppScaffoldPipeline } from "../core/pipeline/definitions/scaffold-cpp";
import { createRustScaffoldPipeline } from "../core/pipeline/definitions/scaffold-rust";

/** All pipeline names accepted by the CLI. */
export type PipelineName =
  | "dev-cycle"
  | "rust-dev-cycle"
  | "cmake-dev-cycle"
  | "doc-cycle"
  | "scaffold-rust"
  | "scaffold-cpp";

/**
 * Select and instantiate a pipeline by name.
 *
 * The best available skill backend is resolved automatically:
 *   - VectorBackend when Ollama is reachable and the LanceDB index exists.
 *   - FileBackend otherwise (graceful fallback, always works).
 *
 * @param name         - Pipeline name from the CLI argument.
 * @param config       - Orchestrator config with wired dispatchers.
 * @param workspace    - Workspace path passed to the pipeline factory.
 * @param skillBackend - Optional override for the skill backend (used in tests).
 */
export async function selectPipeline(
  name: string,
  config: OrchestratorConfig,
  workspace: string,
  skillBackend?: SkillBackend,
): Promise<Result<readonly PipelineStep<AIRequestEvent>[]>> {
  const backend = skillBackend ?? (await createBestBackend());

  switch (name) {
    case "dev-cycle":
      return {
        ok: true,
        value: createDevCyclePipeline(config, workspace, TYPESCRIPT_CONFIG, backend),
      };
    case "rust-dev-cycle":
      return { ok: true, value: createDevCyclePipeline(config, workspace, RUST_CONFIG, backend) };
    case "cmake-dev-cycle":
      return { ok: true, value: createDevCyclePipeline(config, workspace, CPP_CONFIG, backend) };
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

/** FileBackend instance for use in tests — avoids Ollama/LanceDB I/O. */
export const TEST_FILE_BACKEND: SkillBackend = new FileBackend();
