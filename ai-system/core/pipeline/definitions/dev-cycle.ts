import { createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";

/**
 * Creates the TypeScript dev-cycle pipeline: plan → implement → test.
 *
 * Steps:
 *   1. plan       - Sends the original request to claude-sonnet for high-level planning.
 *   2. implement  - Sends the plan + original request to qwen3:8b for implementation.
 *   3. test       - Runs `bun test` in the workspace (nix-aware: wraps in nix develop if
 *                   flake.nix is present).
 *
 * Model routing is handled automatically by the orchestrator:
 *   - action "plan"  → agentic mode → claude-sonnet
 *   - action "edit"  → agentic mode → qwen3:8b
 *
 * @param config    - Orchestrator config mapping model names to dispatchers.
 * @param workspace - Working directory for the test step. Defaults to process.cwd().
 */
export function createDevCyclePipeline(
  config: OrchestratorConfig,
  workspace?: string,
): readonly PipelineStep<AIRequestEvent>[] {
  return [
    createOrchestratorStep("plan", "plan", config),

    createOrchestratorStep("implement", "edit", config, (ctx) => {
      const plan = ctx.results.get("plan")?.output ?? "";
      const original = ctx.event.payload.input ?? "";
      return `Implement the following plan:\n\n${plan}\n\nOriginal request: ${original}`;
    }),

    createNixShellStep<AIRequestEvent>("test", ["bun", "test"], { cwd: workspace }),
  ];
}
