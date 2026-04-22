import {
  createCoverageGateStep,
  createFileWriterStep,
  createNixShellStep,
} from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";

const DEFAULT_COVERAGE_THRESHOLD = 90;

/** LLM options for Rust implementation steps. */
const IMPLEMENT_LLM_OPTIONS: LLMOptions = {
  system:
    "You are a Rust coding assistant. Output ONLY the implementation code in fenced code blocks. " +
    "Each block must have the format: ```<language> <relative-file-path>. " +
    "Follow Rust idioms: use Result/Option, avoid unwrap in production code, prefer ownership over cloning. " +
    "Do not include any explanation or prose outside the code blocks.",
  temperature: 0.4,
};

/**
 * Creates the Rust dev-cycle pipeline:
 * plan → implement → write-files → fmt → clippy → test → tarpaulin → coverage gate.
 *
 * Steps:
 *   1. plan          - High-level planning via the planner model.
 *   2. implement     - Code generation via the implementer model, informed by the plan.
 *   3. write-files   - Parses fenced code blocks from implement output and writes them to disk.
 *   4. fmt           - cargo fmt --check (fails on formatting violations).
 *   5. clippy        - cargo clippy -- -D warnings (fails on any lint warning).
 *   6. test          - cargo test (fails on any failing test).
 *   7. tarpaulin     - cargo tarpaulin (runs with failOnNonZero: false; coverage gate handles result).
 *   8. coverage      - Parses tarpaulin output and fails if coverage is below threshold.
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

    createOrchestratorStep(
      "implement",
      "edit",
      config,
      (ctx) => {
        const plan = ctx.results.get("plan")?.output ?? "";
        const original = ctx.event.payload.input ?? "";
        return `Implement the following plan in Rust. Output ONLY fenced code blocks with file paths.\n\nPlan:\n${plan}\n\nOriginal request: ${original}`;
      },
      IMPLEMENT_LLM_OPTIONS,
    ),

    createFileWriterStep<AIRequestEvent>("write-files", {
      readFrom: "implement",
      baseDir: workspace,
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
