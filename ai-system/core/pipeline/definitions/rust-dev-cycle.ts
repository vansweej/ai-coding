import { createCoverageGateStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";

const DEFAULT_COVERAGE_THRESHOLD = 90;

/**
 * Creates the Rust dev-cycle pipeline: plan → implement → fmt → clippy → test → tarpaulin → coverage gate.
 *
 * Steps:
 *   1. plan          - High-level planning via claude-sonnet.
 *   2. implement     - Code generation via qwen3:8b, informed by the plan.
 *   3. fmt           - cargo fmt --check (fails on formatting violations).
 *   4. clippy        - cargo clippy -- -D warnings (fails on any lint warning).
 *   5. test          - cargo test (fails on any failing test).
 *   6. tarpaulin     - cargo tarpaulin (runs with failOnNonZero: false; coverage gate handles the result).
 *   7. coverage      - Parses tarpaulin output and fails if coverage is below threshold.
 *
 * All shell steps are nix-aware: they run inside `nix develop` when flake.nix
 * is detected in the workspace directory.
 *
 * @param config            - Orchestrator config mapping model names to dispatchers.
 * @param workspace         - Path to the Rust project root (must contain Cargo.toml).
 * @param coverageThreshold - Minimum acceptable coverage percentage. Defaults to 90.
 */
export function createRustDevCyclePipeline(
  config: OrchestratorConfig,
  workspace: string,
  coverageThreshold: number = DEFAULT_COVERAGE_THRESHOLD,
): readonly PipelineStep<AIRequestEvent>[] {
  return [
    createOrchestratorStep("plan", "plan", config),

    createOrchestratorStep("implement", "edit", config, (ctx) => {
      const plan = ctx.results.get("plan")?.output ?? "";
      const original = ctx.event.payload.input ?? "";
      return `Implement the following plan in Rust:\n\n${plan}\n\nOriginal request: ${original}`;
    }),

    createNixShellStep<AIRequestEvent>("fmt", ["cargo", "fmt", "--check"], { cwd: workspace }),

    createNixShellStep<AIRequestEvent>("clippy", ["cargo", "clippy", "--", "-D", "warnings"], {
      cwd: workspace,
    }),

    createNixShellStep<AIRequestEvent>("test", ["cargo", "test"], { cwd: workspace }),

    createNixShellStep<AIRequestEvent>("tarpaulin", ["cargo", "tarpaulin"], {
      cwd: workspace,
      failOnNonZero: false,
    }),

    createCoverageGateStep<AIRequestEvent>("coverage", "tarpaulin", coverageThreshold),
  ];
}
