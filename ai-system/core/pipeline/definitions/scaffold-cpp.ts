import { createFileWriterStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createOrchestratorStep } from "../steps/orchestrator-step";

const DEFAULT_BUILD_DIR = "build";

const GENERATE_PROMPT = `Generate a minimal C++ project scaffold with the following files:

1. CMakeLists.txt -- C++20, an executable target named "app" from src/main.cpp, CTest enabled
2. src/main.cpp -- a hello-world main that prints "Hello, world!" and returns 0
3. flake.nix -- a Nix flake with a devShell containing cmake, gcc, and pkg-config

Output ONLY the three files using this exact fenced code block format for each:

\`\`\`cmake CMakeLists.txt
<content>
\`\`\`

\`\`\`cpp src/main.cpp
<content>
\`\`\`

\`\`\`nix flake.nix
<content>
\`\`\`

Do not include any explanation or prose outside the code blocks.`;

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
