import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import type { PipelineStep } from "../pipeline-types";
import { createOrchestratorStep } from "../steps/orchestrator-step";
import { createShellStep } from "../steps/shell-step";

/**
 * Creates the built-in dev-cycle pipeline: plan → implement → test.
 *
 * Steps:
 *   1. plan       - Sends the original request to claude-sonnet for high-level planning.
 *   2. implement  - Sends the plan + original request to qwen2.5-coder:7b for implementation.
 *   3. test       - Runs `bun test` in the workspace to verify the implementation.
 *
 * Model routing is handled automatically by the orchestrator:
 *   - action "plan"  → agentic mode → claude-sonnet
 *   - action "edit"  → agentic mode → qwen2.5-coder:7b
 *
 * @param config    - Orchestrator config mapping model names to dispatchers.
 * @param workspace - Working directory for the test step. Defaults to process.cwd().
 */
export function createDevCyclePipeline(
  config: OrchestratorConfig,
  workspace?: string,
): readonly PipelineStep[] {
  return [
    createOrchestratorStep("plan", "plan", config),

    createOrchestratorStep("implement", "edit", config, (ctx) => {
      const plan = ctx.results.get("plan")?.output ?? "";
      const original = ctx.event.payload.input ?? "";
      return `Implement the following plan:\n\n${plan}\n\nOriginal request: ${original}`;
    }),

    createShellStep("test", ["bun", "test"], { cwd: workspace }),
  ];
}
