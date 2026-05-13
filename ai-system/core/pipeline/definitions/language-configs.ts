import { createCoverageGateStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

const DEFAULT_COVERAGE_THRESHOLD = 90;
const DEFAULT_CPP_BUILD_DIR = "build";

/** Language-specific configuration for the unified dev-cycle pipeline. */
export interface DevCycleLanguageConfig {
  /** Stable language identifier used by CLI arguments and tests. */
  readonly name: "typescript" | "rust" | "cpp";
  /** System prompt for implementation and fix LLM calls. */
  readonly implementSystem: string;
  /** Short language hint included in user prompts. */
  readonly languageHint: string;
  /** Verification steps run once after all implementation steps in a phase. */
  toolchainSteps(workspace: string): readonly PipelineStep<AIRequestEvent>[];
}

/** TypeScript/Bun verification and implementation rules. */
export const TYPESCRIPT_CONFIG: DevCycleLanguageConfig = {
  name: "typescript",
  languageHint: "TypeScript",
  implementSystem:
    "You are a TypeScript coding assistant. Output ONLY implementation code in fenced code blocks. " +
    "Each block must have the format: ```<language> <relative-file-path>. " +
    "Use named exports, strict types, Result patterns for fallible operations, and idiomatic doc comments on all public items. " +
    "Do not include any explanation or prose outside the code blocks.",
  toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
    createNixShellStep<AIRequestEvent>("typecheck", ["bun", "run", "typecheck"], {
      cwd: workspace,
    }),
    createNixShellStep<AIRequestEvent>("lint", ["bunx", "biome", "check", "--write", "."], {
      cwd: workspace,
    }),
    createNixShellStep<AIRequestEvent>("test", ["bun", "test", "--coverage"], { cwd: workspace }),
  ],
};

/** Rust verification and implementation rules. */
export const RUST_CONFIG: DevCycleLanguageConfig = {
  name: "rust",
  languageHint: "Rust",
  implementSystem:
    "You are a Rust coding assistant. Output ONLY implementation code in fenced code blocks. " +
    "Each block must have the format: ```<language> <relative-file-path>. " +
    "Follow Rust idioms: use Result/Option, avoid unwrap in production code, prefer ownership over cloning, and include idiomatic doc comments on all public items. " +
    "Do not include any explanation or prose outside the code blocks.",
  toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
    createNixShellStep<AIRequestEvent>("fmt", ["cargo", "fmt", "--check"], { cwd: workspace }),
    createNixShellStep<AIRequestEvent>("clippy", ["cargo", "clippy", "--", "-D", "warnings"], {
      cwd: workspace,
    }),
    createNixShellStep<AIRequestEvent>("test", ["cargo", "test"], { cwd: workspace }),
    createNixShellStep<AIRequestEvent>("tarpaulin", ["cargo", "tarpaulin"], {
      cwd: workspace,
      failOnNonZero: false,
    }),
    createCoverageGateStep<AIRequestEvent>("coverage", "tarpaulin", DEFAULT_COVERAGE_THRESHOLD),
  ],
};

/** C++/CMake verification and implementation rules. */
export const CPP_CONFIG: DevCycleLanguageConfig = {
  name: "cpp",
  languageHint: "C++",
  implementSystem:
    "You are a C++ coding assistant. Output ONLY implementation code in fenced code blocks. " +
    "Each block must have the format: ```<language> <relative-file-path>. " +
    "Use C++20 idioms, modern CMake conventions, and idiomatic doc comments on all public items. " +
    "Do not include any explanation or prose outside the code blocks.",
  toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
    createNixShellStep<AIRequestEvent>(
      "configure",
      ["cmake", "-S", ".", "-B", DEFAULT_CPP_BUILD_DIR],
      { cwd: workspace },
    ),
    createNixShellStep<AIRequestEvent>("build", ["cmake", "--build", DEFAULT_CPP_BUILD_DIR], {
      cwd: workspace,
    }),
    createNixShellStep<AIRequestEvent>(
      "test",
      ["ctest", "--test-dir", DEFAULT_CPP_BUILD_DIR, "--output-on-failure"],
      { cwd: workspace },
    ),
  ],
};

/** Built-in language configurations keyed by CLI language name. */
export const DEV_CYCLE_LANGUAGE_CONFIGS: Readonly<
  Record<DevCycleLanguageConfig["name"], DevCycleLanguageConfig>
> = {
  typescript: TYPESCRIPT_CONFIG,
  rust: RUST_CONFIG,
  cpp: CPP_CONFIG,
};
