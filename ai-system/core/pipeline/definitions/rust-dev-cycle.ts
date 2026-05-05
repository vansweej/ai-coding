import {
  createCoverageGateStep,
  createFileWriterStep,
  createNixShellStep,
} from "@ai-coding/pipeline";
import type { PipelineContext, PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { SkillBackend } from "@ai-coding/skills";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";
import { createSkillResolverStep } from "../steps/skill-resolver-step";

const DEFAULT_COVERAGE_THRESHOLD = 90;

/** Name of the skill resolver step — used by downstream steps to read skill context. */
const SKILL_STEP_NAME = "resolve-skills";

/** Base system prompt for Rust implementation steps. */
const IMPLEMENT_BASE_SYSTEM =
  "You are a Rust coding assistant. Output ONLY the implementation code in fenced code blocks. " +
  "Each block must have the format: ```<language> <relative-file-path>. " +
  "Follow Rust idioms: use Result/Option, avoid unwrap in production code, prefer ownership over cloning. " +
  "Do not include any explanation or prose outside the code blocks.";

/**
 * Build dynamic LLM options for the implement step.
 * When skill content is available in context, it is prepended to the system prompt
 * so the LLM receives domain-specific instructions before the base Rust coding rules.
 */
function buildImplementLlmOptions(ctx: PipelineContext<AIRequestEvent>): LLMOptions {
  const skillContent = ctx.results.get(SKILL_STEP_NAME)?.output ?? "";
  const system = skillContent
    ? `${skillContent}\n\n---\n\n${IMPLEMENT_BASE_SYSTEM}`
    : IMPLEMENT_BASE_SYSTEM;
  return { system, temperature: 0.4 };
}

/**
 * Creates the Rust dev-cycle pipeline:
 * [resolve-skills →] plan → implement → write-files → fmt → clippy → test → tarpaulin → coverage gate.
 *
 * Steps:
 *   0. resolve-skills (optional) - Resolves relevant skills and stores merged content
 *                                   in context for downstream steps to use.
 *   1. plan          - High-level planning via the planner model.
 *   2. implement     - Code generation via the implementer model, informed by the plan.
 *                      When skill resolution ran, skill content is prepended to the system prompt.
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
 * @param skillBackend      - Optional skill backend. When provided, a skill resolver step is inserted
 *                            before the plan step and skill content enriches the implement system prompt.
 */
export function createRustDevCyclePipeline(
  config: OrchestratorConfig,
  workspace: string,
  coverageThreshold: number = DEFAULT_COVERAGE_THRESHOLD,
  skillBackend?: SkillBackend,
): readonly PipelineStep<AIRequestEvent>[] {
  const steps: PipelineStep<AIRequestEvent>[] = [];

  if (skillBackend !== undefined) {
    steps.push(createSkillResolverStep(SKILL_STEP_NAME, skillBackend));
  }

  steps.push(
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
      undefined,
      buildImplementLlmOptions,
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
  );

  return steps;
}
