import { createFileWriterStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";

const DEFAULT_BUILD_DIR = "build";

const GENERATE_PROMPT = `Generate a minimal C++ project scaffold with exactly these three files.

Use EXACTLY this structure for each file (do NOT change the schema):

\`\`\`cmake CMakeLists.txt
cmake_minimum_required(VERSION 3.20)
project(app LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(app src/main.cpp)

enable_testing()
\`\`\`

\`\`\`cpp src/main.cpp
#include <iostream>

int main() {
  std::cout << "Hello, world!" << std::endl;
  return 0;
}
\`\`\`

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
            cmake
            gcc
            pkg-config
          ];
        };
      });
    };
}
\`\`\`

Output ONLY the three files shown above. Do not include any explanation or prose outside the code blocks.`;

/**
 * Creates the C++ scaffold pipeline: generate → write-files → configure.
 *
 * Steps:
 *   1. generate    - LLM generates CMakeLists.txt, src/main.cpp, and flake.nix.
 *   2. write-files - Parses LLM output and writes all generated files to the workspace.
 *   3. configure   - cmake -S . -B <buildDir> to verify the project configures cleanly.
 *
 * After this pipeline completes, the workspace contains a fully scaffolded
 * C++ project with a Nix flake and a configured CMake build directory.
 * Run `nix develop` to enter the dev shell, then `cmake --build <buildDir>` to build.
 *
 * @param config    - Orchestrator config mapping model names to dispatchers.
 * @param workspace - Absolute path to the directory where the project is scaffolded.
 *                    The directory must already exist.
 * @param buildDir  - CMake build directory name. Defaults to "build".
 */
export function createCppScaffoldPipeline(
  config: OrchestratorConfig,
  workspace: string,
  buildDir: string = DEFAULT_BUILD_DIR,
): readonly PipelineStep<AIRequestEvent>[] {
  return [
    createOrchestratorStep("generate", "task", config, () => GENERATE_PROMPT),

    createFileWriterStep<AIRequestEvent>("write-files", {
      readFrom: "generate",
      baseDir: workspace,
    }),

    createNixShellStep<AIRequestEvent>("configure", ["cmake", "-S", ".", "-B", buildDir], {
      cwd: workspace,
    }),
  ];
}
