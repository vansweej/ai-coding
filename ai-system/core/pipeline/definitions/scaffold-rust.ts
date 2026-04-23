import { createFileWriterStep, createNixShellStep, createShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { LLMOptions, OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";

const AGENTS_MD_CONTENT = `# Project Agent Instructions

## Build Commands

\`\`\`bash
# Enter the development shell
nix develop

# Build
cargo build

# Test
cargo test

# Lint
cargo clippy -- -D warnings

# Format
cargo fmt

# Coverage
cargo tarpaulin --out html
\`\`\`

## Language

This is a Rust project. When using OpenCode skills, load the \`rust\` skill
for language-specific coding standards, error handling, and tooling rules.
`;

const GENERATE_FLAKE_PROMPT = `Generate a Nix flake for a Rust development environment.

Use EXACTLY this structure (you may adjust the package list but NOT the schema):

\`\`\`nix flake.nix
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.\${system});
    in {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            rustc
            cargo
            clippy
            rustfmt
            cargo-tarpaulin
          ];
        };
      });
    };
}
\`\`\`

Output ONLY the file shown above. Do not include any explanation or prose outside the code block.`;

/** LLM options for scaffold generation steps: tighter temperature for deterministic output. */
const SCAFFOLD_LLM_OPTIONS: LLMOptions = {
  system:
    "You are a code generator. Output only the requested code blocks exactly as shown. " +
    "Do not include any prose or explanation outside the code blocks.",
  temperature: 0.3,
};

/**
 * Creates the Rust scaffold pipeline: generate-flake → write-files → git-init → init.
 *
 * The flake is generated and written first so that `cargo init` runs inside
 * the project's own dev shell -- the flake is the single source of truth for
 * tooling. git-init tracks flake.nix so that `nix develop` can see it.
 *
 * Steps:
 *   1. generate-flake - LLM generates a flake.nix for the Rust dev environment.
 *   2. write-files    - Parses LLM output and writes flake.nix to the workspace.
 *   3. git-init       - `git init && git add flake.nix` so nix develop can read the flake.
 *   4. init           - `nix develop --command cargo init .` inside the workspace.
 *
 * After this pipeline completes, the workspace contains a fully scaffolded
 * Rust project with a Nix flake. Run `nix develop` to enter the dev shell,
 * then `cargo build` to verify the project compiles.
 *
 * @param config    - Orchestrator config mapping model names to dispatchers.
 * @param workspace - Absolute path to the directory where the project is scaffolded.
 *                    The directory must already exist.
 */
export function createRustScaffoldPipeline(
  config: OrchestratorConfig,
  workspace: string,
): readonly PipelineStep<AIRequestEvent>[] {
  return [
    // Use "plan" action so the legacy router routes to claude-sonnet-4.6,
    // and the copilot-default profile maps the planner role to claude-sonnet-4.6.
    createOrchestratorStep(
      "generate-flake",
      "plan",
      config,
      () => GENERATE_FLAKE_PROMPT,
      SCAFFOLD_LLM_OPTIONS,
    ),

    createFileWriterStep<AIRequestEvent>("write-files", {
      readFrom: "generate-flake",
      baseDir: workspace,
    }),

    createShellStep<AIRequestEvent>("git-init", ["sh", "-c", "git init && git add flake.nix"], {
      cwd: workspace,
    }),

    createNixShellStep<AIRequestEvent>("init", ["cargo", "init", "."], { cwd: workspace }),

    createShellStep<AIRequestEvent>(
      "write-agents-md",
      ["sh", "-c", `printf '%s' ${JSON.stringify(AGENTS_MD_CONTENT)} > AGENTS.md`],
      { cwd: workspace },
    ),
  ];
}
