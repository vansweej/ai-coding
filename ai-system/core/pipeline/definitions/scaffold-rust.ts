import { createFileWriterStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";

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

/**
 * Creates the Rust scaffold pipeline: init → generate-flake → write-files.
 *
 * Steps:
 *   1. init           - cargo init <workspace> (creates Cargo.toml and src/main.rs).
 *   2. generate-flake - LLM generates a flake.nix for the Rust dev environment.
 *   3. write-files    - Parses LLM output and writes flake.nix to the workspace.
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
    createNixShellStep<AIRequestEvent>("init", ["cargo", "init", workspace]),

    createOrchestratorStep("generate-flake", "task", config, () => GENERATE_FLAKE_PROMPT),

    createFileWriterStep<AIRequestEvent>("write-files", {
      readFrom: "generate-flake",
      baseDir: workspace,
    }),
  ];
}
