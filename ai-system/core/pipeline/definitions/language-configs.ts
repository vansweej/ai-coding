import { createCoverageGateStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { CoverageDirective, LanguageName } from "../plan-parser";
import { resolveCoverageThreshold } from "../steps/coverage-exemption";

const DEFAULT_COVERAGE_THRESHOLD = 90;
const DEFAULT_CPP_BUILD_DIR = "build";

/** Language-specific configuration for the unified dev-cycle pipeline. */
export interface DevCycleLanguageConfig {
  /** Stable language identifier used by CLI arguments and tests. */
  readonly name: LanguageName;
  /** System prompt for implementation and fix LLM calls. */
  readonly implementSystem: string;
  /** Short language hint included in user prompts. */
  readonly languageHint: string;
  /** File extensions to collect when building source context (e.g. [".ts", ".tsx"]). */
  readonly sourceExtensions: readonly string[];
  /**
   * Source root directories, relative to the workspace root, to search when
   * collecting source context. When omitted, defaults to the workspace root (".").
   */
  readonly sourceRoots?: readonly string[];
  /** Verification steps run once after all implementation steps in a phase. */
  toolchainSteps(workspace: string): readonly PipelineStep<AIRequestEvent>[];
}

/** TypeScript/Bun verification and implementation rules. */
export const TYPESCRIPT_CONFIG: DevCycleLanguageConfig = {
  name: "typescript",
  languageHint: "TypeScript",
  sourceExtensions: [".ts"],
  sourceRoots: ["src", "."],
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
  sourceExtensions: [".rs"],
  sourceRoots: ["src"],
  implementSystem:
    "You are a Rust coding assistant. Output ONLY implementation code in fenced code blocks. " +
    "Each block must have the format: ```<language> <relative-file-path>. " +
    "Follow Rust idioms: use Result/Option, avoid unwrap in production code, prefer ownership over cloning, and include idiomatic doc comments on all public items. " +
    "Generate compilable Rust code. Ensure all use statements are present and all types, functions, and macros referenced are either in the standard prelude or explicitly imported. " +
    "Do not include any explanation or prose outside the code blocks.",
  toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
    createNixShellStep<AIRequestEvent>("fmt", ["cargo", "fmt", "--check"], { cwd: workspace }),
    createNixShellStep<AIRequestEvent>("check", ["cargo", "check", "--quiet"], { cwd: workspace }),
    createNixShellStep<AIRequestEvent>("clippy", ["cargo", "clippy", "--", "-D", "warnings"], {
      cwd: workspace,
    }),
    createNixShellStep<AIRequestEvent>("test", ["cargo", "test"], { cwd: workspace }),
    createNixShellStep<AIRequestEvent>("tarpaulin", ["cargo", "tarpaulin"], {
      cwd: workspace,
      failOnNonZero: false,
    }),
    createCoverageGateStep<AIRequestEvent>(
      "coverage",
      "tarpaulin",
      DEFAULT_COVERAGE_THRESHOLD,
      undefined,
      true,
    ),
  ],
};

/**
 * Rust plan-cycle configuration with fatal coverage gate and autofix fmt.
 *
 * Differs from RUST_CONFIG in two ways:
 *   1. Coverage gate is fatal (warnOnly: false) instead of warning-only
 *   2. `cargo fmt --check` becomes `cargo fmt` (autofix) instead of check-only
 *
 * This configuration is used by the `rust-plan-cycle` pipeline for unattended
 * plan execution where coverage failures should halt the phase and fmt should
 * automatically fix formatting issues.
 *
 * The coverage step consults per-phase directives and auto-exempt logic via
 * `resolveCoverageThreshold()` to determine the effective threshold and whether
 * the gate is enforced.
 */
export function createRustPlanConfig(
  phaseCoverage: CoverageDirective,
  diff: string,
): DevCycleLanguageConfig {
  const { gated, percent } = resolveCoverageThreshold(phaseCoverage, diff);

  return {
    name: "rust",
    languageHint: "Rust",
    sourceExtensions: [".rs"],
    sourceRoots: ["src"],
    implementSystem:
      "You are a Rust coding assistant. Output ONLY aider-style SEARCH/REPLACE patches for files that need changes. " +
      "Each patch must have the format:\n" +
      "<file-path>\n" +
      "<<<<<<< SEARCH\n" +
      "<exact anchor text>\n" +
      "=======\n" +
      "<replacement text>\n" +
      ">>>>>>> REPLACE\n\n" +
      "Follow Rust idioms: use Result/Option, avoid unwrap in production code, prefer ownership over cloning, and include idiomatic doc comments on all public items. " +
      "Generate compilable Rust code. Ensure all use statements are present and all types, functions, and macros referenced are either in the standard prelude or explicitly imported. " +
      "Do not include any explanation or prose outside the patches.",
    toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      createNixShellStep<AIRequestEvent>("fmt", ["cargo", "fmt"], { cwd: workspace }),
      createNixShellStep<AIRequestEvent>("check", ["cargo", "check", "--quiet"], {
        cwd: workspace,
      }),
      createNixShellStep<AIRequestEvent>("clippy", ["cargo", "clippy", "--", "-D", "warnings"], {
        cwd: workspace,
      }),
      createNixShellStep<AIRequestEvent>("test", ["cargo", "test"], { cwd: workspace }),
      createNixShellStep<AIRequestEvent>("tarpaulin", ["cargo", "tarpaulin"], {
        cwd: workspace,
        failOnNonZero: false,
      }),
      // Coverage gate is fatal (warnOnly: false) and respects per-phase directives
      createCoverageGateStep<AIRequestEvent>(
        "coverage",
        "tarpaulin",
        percent,
        undefined,
        !gated, // If gated is false, treat as warning-only; if true, make it fatal
      ),
    ],
  };
}

/** Exported constant for RUST_PLAN_CONFIG with default coverage (90%, gated). */
export const RUST_PLAN_CONFIG: DevCycleLanguageConfig = createRustPlanConfig(
  { mode: "default" },
  "",
);

/** C++/CMake verification and implementation rules. */
export const CPP_CONFIG: DevCycleLanguageConfig = {
  name: "cpp",
  languageHint: "C++",
  sourceExtensions: [".cpp", ".h", ".hpp"],
  sourceRoots: ["src", "include"],
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
  Partial<Record<LanguageName, DevCycleLanguageConfig>>
> = {
  typescript: TYPESCRIPT_CONFIG,
  rust: RUST_CONFIG,
  cpp: CPP_CONFIG,
};
