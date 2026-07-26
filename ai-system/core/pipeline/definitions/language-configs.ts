import { createCoverageGateStep, createNixShellStep } from "@ai-coding/pipeline";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import type { CoverageDirective, LanguageName } from "../plan-parser";
import { resolveCoverageThreshold } from "../steps/coverage-exemption";

const DEFAULT_COVERAGE_THRESHOLD = 90;
const DEFAULT_CPP_BUILD_DIR = "build";

/**
 * Build the `implementSystem` prompt for plan-cycle configs that use aider-style
 * SEARCH/REPLACE patches.
 *
 * @param languageHint - Human-readable language name used in the opening sentence (e.g. "Rust").
 * @param idioms       - Language-specific coding rules appended after the patch format block.
 */
function buildPatchSystem(languageHint: string, idioms: string): string {
  return `You are a ${languageHint} coding assistant. Output ONLY aider-style SEARCH/REPLACE patches for files that need changes. Each patch must have the format:\n<file-path>\n<<<<<<< SEARCH\n<exact anchor text>\n=======\n<replacement text>\n>>>>>>> REPLACE\n\n${idioms} Do not include any explanation or prose outside the patches.`;
}

const RUST_PLAN_IDIOMS =
  "Follow Rust idioms: use Result/Option, avoid unwrap in production code, prefer ownership over cloning, and include idiomatic doc comments on all public items. " +
  "Generate compilable Rust code. Ensure all use statements are present and all types, functions, and macros referenced are either in the standard prelude or explicitly imported.";

const TS_PLAN_IDIOMS =
  "Use named exports, strict types, Result patterns for fallible operations, and idiomatic doc comments on all public items. " +
  "Generate compilable TypeScript code. Ensure all imports are present.";

const PYTHON_PLAN_IDIOMS =
  "Use type hints on all function signatures, follow PEP 8 conventions, prefer explicit error handling over broad exception catching, and include docstrings on all public functions and classes. " +
  "Generate code compatible with the project's ruff and mypy configuration. Ensure all imports are present.";

const CPP_PLAN_IDIOMS =
  "Use C++20 idioms, modern target-based CMake conventions, RAII for resource management, and include doc comments on all public items. " +
  "Generate compilable C++ code. Ensure all necessary #include directives are present.";

const HASKELL_PLAN_IDIOMS =
  "Follow idiomatic Haskell: prefer pure functions, use Maybe/Either for error handling, avoid partial functions (head, fromJust) in production code, and include Haddock doc comments on all exported items. " +
  "Generate compilable Haskell code. Ensure all necessary imports are present.";

const JULIA_PLAN_IDIOMS =
  "Follow idiomatic Julia: use multiple dispatch appropriately, prefer type-stable functions, avoid global mutable state, and include docstrings on all exported functions and types. " +
  "Ensure the code loads and runs without syntax errors.";

const NIX_PLAN_IDIOMS =
  "Follow idiomatic Nix: use let-in bindings for clarity, prefer attribute sets over positional arguments, keep derivations pure, and include comments explaining non-obvious expressions. " +
  "Generate syntactically valid Nix expressions.";

const SHELL_PLAN_IDIOMS =
  "Follow POSIX-compatible shell idioms where possible, quote all variable expansions, start scripts with `set -euo pipefail`, and ensure the script passes shellcheck. " +
  "Generate syntactically valid shell code.";

const DOCS_PLAN_IDIOMS =
  "Write clear, well-structured Markdown; match the surrounding document's tone and heading levels; do not touch unrelated sections.";

/**
 * Factory that creates a language-specific plan-cycle config from the phase's
 * coverage directive and current git diff.  Registered factories are keyed by
 * LanguageName so the phase-runner can look one up without knowing the language
 * at compile time.
 */
export type PlanConfigFactory = (
  coverage: CoverageDirective,
  diff: string,
) => DevCycleLanguageConfig;

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
  /**
   * When true, `runPhase` runs `toolchainSteps` once on the untouched tree
   * BEFORE any implementation attempt for the phase. A failure here indicates
   * the workspace was already broken (e.g. a stale `nix flake check` or a
   * pre-existing whole-repo lint failure) rather than something the phase's
   * implementation introduced, so it is treated as an environment error
   * (`BaselineCheckError`) rather than an ordinary phase failure.
   *
   * Intended for whole-repo validators that cannot be scoped to a diff
   * (e.g. `nix flake check`, `shellcheck` across all scripts).
   */
  readonly baselineCheck?: boolean;
  /** Verification steps run once after all implementation steps in a phase. */
  toolchainSteps(workspace: string): readonly PipelineStep<AIRequestEvent>[];
}

/** TypeScript/Bun verification and implementation rules. */
export const TYPESCRIPT_CONFIG: DevCycleLanguageConfig = {
  name: "typescript",
  languageHint: "TypeScript",
  sourceExtensions: [".ts", ".md"],
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
  sourceExtensions: [".rs", ".md"],
  // "src" for single-crate projects, "crates" for cargo workspaces
  // (crates/<name>/src/*.rs), and "." as a catch-all for non-standard layouts.
  sourceRoots: ["src", "crates", "."],
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
    sourceExtensions: [".rs", ".md"],
    sourceRoots: ["src", "crates", "."],
    implementSystem: buildPatchSystem("Rust", RUST_PLAN_IDIOMS),
    toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => {
      const baseSteps: PipelineStep<AIRequestEvent>[] = [
        createNixShellStep<AIRequestEvent>("fmt", ["cargo", "fmt"], { cwd: workspace }),
        createNixShellStep<AIRequestEvent>("check", ["cargo", "check", "--quiet"], {
          cwd: workspace,
        }),
        createNixShellStep<AIRequestEvent>("clippy", ["cargo", "clippy", "--", "-D", "warnings"], {
          cwd: workspace,
        }),
        createNixShellStep<AIRequestEvent>("test", ["cargo", "test"], { cwd: workspace }),
      ];

      // When coverage isn't gated (Coverage: skip or auto-exempt), skip the
      // tarpaulin instrumented rebuild entirely rather than just softening
      // the gate. cargo tarpaulin performs its own instrumented build, which
      // on heavy workspaces can exceed the shell step's 60s default timeout
      // -- a timeout rejects the step regardless of failOnNonZero, failing
      // verification even when the code is correct. If there's no coverage
      // number to enforce, there's no reason to pay for that build.
      if (!gated) {
        return baseSteps;
      }

      return [
        ...baseSteps,
        createNixShellStep<AIRequestEvent>("tarpaulin", ["cargo", "tarpaulin"], {
          cwd: workspace,
          failOnNonZero: false,
          // Instrumented rebuilds of heavy workspaces can take well over the
          // 60s shell-step default; give gated phases a realistic budget.
          timeoutMs: 900_000,
        }),
        // Coverage gate is fatal when gated (per-phase directives/auto-exempt
        // already resolved above).
        createCoverageGateStep<AIRequestEvent>("coverage", "tarpaulin", percent, undefined, false),
      ];
    },
  };
}

/** Exported constant for RUST_PLAN_CONFIG with the default 90% fatal gate. */
export const RUST_PLAN_CONFIG: DevCycleLanguageConfig = createRustPlanConfig(
  { mode: "threshold", percent: 90 },
  "",
);

/**
 * TypeScript plan-cycle configuration.
 *
 * Uses aider-style SEARCH/REPLACE patches like the Rust plan-cycle, but runs
 * the Bun/Biome toolchain instead of Cargo. No coverage gate is applied —
 * the test step runs `bun test` with a generous timeout to accommodate the full
 * suite without a separate tarpaulin step.
 *
 * The `coverage` and `diff` parameters are accepted for `PlanConfigFactory`
 * compatibility; TypeScript plan-cycle does not currently gate on coverage.
 */
export function createTsPlanConfig(
  _coverage: CoverageDirective,
  _diff: string,
): DevCycleLanguageConfig {
  return {
    name: "typescript",
    languageHint: "TypeScript",
    sourceExtensions: [".ts", ".md"],
    sourceRoots: ["src", "."],
    implementSystem: buildPatchSystem("TypeScript", TS_PLAN_IDIOMS),
    toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      createNixShellStep<AIRequestEvent>("typecheck", ["bun", "run", "typecheck"], {
        cwd: workspace,
      }),
      createNixShellStep<AIRequestEvent>("lint", ["bunx", "biome", "check", "--write", "."], {
        cwd: workspace,
      }),
      createNixShellStep<AIRequestEvent>("test", ["bun", "test"], {
        cwd: workspace,
        timeoutMs: 300_000,
      }),
    ],
  };
}

/**
 * Python plan-cycle configuration.
 *
 * Toolchain: `ruff format --check` → `ruff check` → `mypy .` (warning-only —
 * fatal on ruff, non-fatal on mypy until the project is fully typed) → `pytest -q`.
 *
 * The `coverage` and `diff` parameters are accepted for `PlanConfigFactory`
 * compatibility; Python plan-cycle does not currently gate on coverage.
 */
export function createPythonPlanConfig(
  _coverage: CoverageDirective,
  _diff: string,
): DevCycleLanguageConfig {
  return {
    name: "python",
    languageHint: "Python",
    sourceExtensions: [".py", ".md"],
    sourceRoots: ["src", "."],
    implementSystem: buildPatchSystem("Python", PYTHON_PLAN_IDIOMS),
    toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      createNixShellStep<AIRequestEvent>("format", ["ruff", "format", "--check", "."], {
        cwd: workspace,
        timeoutMs: 60_000,
      }),
      createNixShellStep<AIRequestEvent>("lint", ["ruff", "check", "."], {
        cwd: workspace,
        timeoutMs: 60_000,
      }),
      // Warning-only until the project is fully typed; tighten to fatal later.
      createNixShellStep<AIRequestEvent>("typecheck", ["mypy", "."], {
        cwd: workspace,
        timeoutMs: 120_000,
        failOnNonZero: false,
      }),
      createNixShellStep<AIRequestEvent>("test", ["pytest", "-q"], {
        cwd: workspace,
        timeoutMs: 300_000,
      }),
    ],
  };
}

/**
 * C++ plan-cycle configuration.
 *
 * Toolchain: `cmake -S . -B build` → `cmake --build build` →
 * `ctest --test-dir build`.
 *
 * The `coverage` and `diff` parameters are accepted for `PlanConfigFactory`
 * compatibility; C++ plan-cycle does not currently gate on coverage.
 */
export function createCppPlanConfig(
  _coverage: CoverageDirective,
  _diff: string,
): DevCycleLanguageConfig {
  return {
    name: "cpp",
    languageHint: "C++",
    sourceExtensions: [".cpp", ".h", ".hpp", ".md"],
    sourceRoots: ["src", "include", "."],
    implementSystem: buildPatchSystem("C++", CPP_PLAN_IDIOMS),
    toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      createNixShellStep<AIRequestEvent>(
        "configure",
        ["cmake", "-S", ".", "-B", DEFAULT_CPP_BUILD_DIR],
        { cwd: workspace, timeoutMs: 120_000 },
      ),
      createNixShellStep<AIRequestEvent>("build", ["cmake", "--build", DEFAULT_CPP_BUILD_DIR], {
        cwd: workspace,
        timeoutMs: 300_000,
      }),
      createNixShellStep<AIRequestEvent>(
        "test",
        ["ctest", "--test-dir", DEFAULT_CPP_BUILD_DIR, "--output-on-failure"],
        { cwd: workspace, timeoutMs: 300_000 },
      ),
    ],
  };
}

/**
 * Haskell plan-cycle configuration.
 *
 * Toolchain: `cabal build` (doubles as typecheck) → `hlint .` → `cabal test`.
 * Build and test steps use a 600s timeout to accommodate GHC compile times.
 *
 * The `coverage` and `diff` parameters are accepted for `PlanConfigFactory`
 * compatibility; Haskell plan-cycle does not currently gate on coverage.
 */
export function createHaskellPlanConfig(
  _coverage: CoverageDirective,
  _diff: string,
): DevCycleLanguageConfig {
  return {
    name: "haskell",
    languageHint: "Haskell",
    sourceExtensions: [".hs", ".md"],
    sourceRoots: ["src", "app", "."],
    implementSystem: buildPatchSystem("Haskell", HASKELL_PLAN_IDIOMS),
    toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      // cabal build doubles as the typecheck step for Haskell.
      createNixShellStep<AIRequestEvent>("build", ["cabal", "build"], {
        cwd: workspace,
        timeoutMs: 600_000,
      }),
      createNixShellStep<AIRequestEvent>("lint", ["hlint", "."], {
        cwd: workspace,
        timeoutMs: 120_000,
      }),
      createNixShellStep<AIRequestEvent>("test", ["cabal", "test"], {
        cwd: workspace,
        timeoutMs: 600_000,
      }),
    ],
  };
}

/**
 * Julia plan-cycle configuration.
 *
 * Toolchain: `julia --project -e 'using Pkg; Pkg.test()'` only. This is a weak
 * verification signal — it exercises the project's own test suite but has no
 * separate format/lint step. A 900s timeout accommodates Julia's package
 * precompilation overhead on cold runs.
 *
 * The `coverage` and `diff` parameters are accepted for `PlanConfigFactory`
 * compatibility; Julia plan-cycle does not currently gate on coverage.
 */
export function createJuliaPlanConfig(
  _coverage: CoverageDirective,
  _diff: string,
): DevCycleLanguageConfig {
  return {
    name: "julia",
    languageHint: "Julia",
    sourceExtensions: [".jl", ".md"],
    sourceRoots: ["src", "."],
    implementSystem: buildPatchSystem("Julia", JULIA_PLAN_IDIOMS),
    toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      createNixShellStep<AIRequestEvent>(
        "test",
        ["julia", "--project", "-e", "using Pkg; Pkg.test()"],
        { cwd: workspace, timeoutMs: 900_000 },
      ),
    ],
  };
}

/**
 * Nix plan-cycle configuration.
 *
 * Toolchain: `nixpkgs-fmt --check .` → `nix flake check`. `nix flake check`
 * cannot be scoped to a diff, so `baselineCheck` is enabled: the whole-repo
 * check runs once on the untouched tree before any implementation attempt,
 * and a pre-existing failure is treated as an environment error rather than
 * something the phase's implementation introduced. A 900s timeout
 * accommodates flake evaluation cost.
 *
 * The `coverage` and `diff` parameters are accepted for `PlanConfigFactory`
 * compatibility; Nix plan-cycle does not currently gate on coverage.
 */
export function createNixPlanConfig(
  _coverage: CoverageDirective,
  _diff: string,
): DevCycleLanguageConfig {
  return {
    name: "nix",
    languageHint: "Nix",
    sourceExtensions: [".nix", ".md"],
    sourceRoots: ["."],
    baselineCheck: true,
    implementSystem: buildPatchSystem("Nix", NIX_PLAN_IDIOMS),
    toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      createNixShellStep<AIRequestEvent>("format", ["nixpkgs-fmt", "--check", "."], {
        cwd: workspace,
        timeoutMs: 60_000,
      }),
      createNixShellStep<AIRequestEvent>("check", ["nix", "flake", "check"], {
        cwd: workspace,
        timeoutMs: 900_000,
      }),
    ],
  };
}

/**
 * Shell plan-cycle configuration.
 *
 * Toolchain: `shfmt -d .` → a guarded shellcheck wrapper that lists tracked
 * `.sh` files via `git ls-files` and only invokes shellcheck when the
 * repository actually has shell scripts (an empty file list would otherwise
 * make shellcheck itself fail with "no files specified"). Whole-repo
 * shellcheck cannot be scoped to a diff, so `baselineCheck` is enabled: the
 * check runs once on the untouched tree before any implementation attempt,
 * and a pre-existing failure is treated as an environment error.
 *
 * The `coverage` and `diff` parameters are accepted for `PlanConfigFactory`
 * compatibility; Shell plan-cycle does not currently gate on coverage.
 */
export function createShellPlanConfig(
  _coverage: CoverageDirective,
  _diff: string,
): DevCycleLanguageConfig {
  return {
    name: "shell",
    languageHint: "Shell",
    sourceExtensions: [".sh", ".md"],
    sourceRoots: ["."],
    baselineCheck: true,
    implementSystem: buildPatchSystem("Shell", SHELL_PLAN_IDIOMS),
    toolchainSteps: (workspace: string): readonly PipelineStep<AIRequestEvent>[] => [
      createNixShellStep<AIRequestEvent>("format", ["shfmt", "-d", "."], {
        cwd: workspace,
        timeoutMs: 60_000,
      }),
      createNixShellStep<AIRequestEvent>(
        "lint",
        ["sh", "-c", 'files=$(git ls-files "*.sh"); [ -z "$files" ] || shellcheck $files'],
        { cwd: workspace, timeoutMs: 120_000 },
      ),
    ],
  };
}

/**
 * Docs (no-op toolchain) plan-cycle configuration.
 *
 * A documentation-only phase (e.g. a README or architecture-doc edit) has
 * nothing to compile, lint, or test — Markdown isn't verified by any
 * toolchain. `toolchainSteps` is intentionally an empty array: the phase
 * still applies its patch and commits normally, but no compiler, linter, or
 * coverage gate ever runs. This exists so a documentation phase inside a
 * compiled-language repo (e.g. a Rust workspace) doesn't drag in that
 * language's full toolchain purely because there is no lighter alternative
 * to inherit.
 *
 * The `coverage` and `diff` parameters are accepted for `PlanConfigFactory`
 * compatibility; docs plan-cycle never gates on coverage (there is nothing
 * to instrument).
 */
export function createDocsPlanConfig(
  _coverage: CoverageDirective,
  _diff: string,
): DevCycleLanguageConfig {
  return {
    name: "docs",
    languageHint: "Markdown",
    sourceExtensions: [".md"],
    sourceRoots: ["docs", "."],
    implementSystem: buildPatchSystem("Markdown", DOCS_PLAN_IDIOMS),
    toolchainSteps: (): readonly PipelineStep<AIRequestEvent>[] => [],
  };
}

/**
 * Registry of plan-config factories keyed by language name.
 *
 * A phase runner looks up the factory for the phase's language (or the run's
 * default language), calls it with the phase's coverage directive and current
 * git diff, and obtains a fully-configured `DevCycleLanguageConfig`.
 *
 * Languages not yet registered here fail cleanly with an "unregistered language"
 * error rather than silently falling back to the wrong toolchain.
 *
 * All 9 known languages are registered.
 */
export const PLAN_CONFIG_FACTORIES: Readonly<Partial<Record<LanguageName, PlanConfigFactory>>> = {
  rust: createRustPlanConfig,
  typescript: createTsPlanConfig,
  python: createPythonPlanConfig,
  cpp: createCppPlanConfig,
  docs: createDocsPlanConfig,
  haskell: createHaskellPlanConfig,
  julia: createJuliaPlanConfig,
  nix: createNixPlanConfig,
  shell: createShellPlanConfig,
};

/** C++/CMake verification and implementation rules. */
export const CPP_CONFIG: DevCycleLanguageConfig = {
  name: "cpp",
  languageHint: "C++",
  sourceExtensions: [".cpp", ".h", ".hpp", ".md"],
  sourceRoots: ["src", "include", "."],
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

/**
 * Descriptor for one toolchain in the devShell-routed model (the eventual
 * replacement for the `--language`/`Language:` knob -- see P1
 * `devShellPalette`). Reuses the same toolchain step bodies and idiom
 * fragments as the `LanguageName`-keyed registry above; this is purely an
 * ADDITIVE re-keying by extension and marker tool, and does not yet change
 * how any phase is routed (that is `route()`, a later phase).
 */
export interface ToolchainDescriptor {
  /** Stable identifier, reusing the existing LanguageName values. */
  readonly id: LanguageName;
  /** Human-readable language name used in implement-prompt idiom text. */
  readonly languageHint: string;
  /**
   * Every binary this toolchain's steps may invoke, e.g. ["cargo", "rustc",
   * "cargo-clippy", "rustfmt", "cargo-tarpaulin"] for Rust. Used both to
   * build the CANDIDATE_TOOLS union passed to `devShellPalette` and, later,
   * by `route()` to decide whether this toolchain is available in a given
   * workspace's devShell.
   *
   * NOTE: the Rust clippy binary is named `cargo-clippy`, not `clippy` --
   * confirmed by manually probing a real Rust devShell (`clippy` alone does
   * not resolve via `command -v`; `cargo-clippy`/`clippy-driver` do).
   */
  readonly markerTools: readonly string[];
  /** Language-specific coding idioms appended to the aider patch-format prompt. */
  readonly idioms: string;
  /**
   * True for toolchains whose verification cannot be scoped to a diff (e.g.
   * `nix flake check`, whole-repo `shellcheck`) and must instead run once on
   * the untouched tree, with a pre-existing failure treated as an
   * environment error. Mirrors the role `DevCycleLanguageConfig.baselineCheck`
   * plays today.
   */
  readonly isWholeRepoValidator?: boolean;
  /** Verification steps for this toolchain, optionally coverage/diff-aware (Rust only, currently). */
  toolchainSteps(
    workspace: string,
    coverage?: CoverageDirective,
    diff?: string,
  ): readonly PipelineStep<AIRequestEvent>[];
}

const DEFAULT_PLAN_COVERAGE: CoverageDirective = { mode: "threshold", percent: 90 };

/**
 * Registry of toolchain descriptors keyed by LanguageName, reusing the
 * existing `create*PlanConfig` factories and `*_PLAN_IDIOMS` fragments so
 * there is exactly one source of truth for each toolchain's steps and idioms.
 * `docs` is intentionally absent: it is not a real toolchain but the
 * no-toolchain floor that any unmapped file extension already falls back to.
 */
export const TOOLCHAIN_DESCRIPTORS: Readonly<
  Record<Exclude<LanguageName, "docs">, ToolchainDescriptor>
> = {
  rust: {
    id: "rust",
    languageHint: "Rust",
    markerTools: ["cargo", "rustc", "cargo-clippy", "rustfmt", "cargo-tarpaulin"],
    idioms: RUST_PLAN_IDIOMS,
    toolchainSteps: (workspace, coverage, diff) =>
      createRustPlanConfig(coverage ?? DEFAULT_PLAN_COVERAGE, diff ?? "").toolchainSteps(workspace),
  },
  typescript: {
    id: "typescript",
    languageHint: "TypeScript",
    markerTools: ["bun"],
    idioms: TS_PLAN_IDIOMS,
    toolchainSteps: (workspace) =>
      createTsPlanConfig({ mode: "default" }, "").toolchainSteps(workspace),
  },
  python: {
    id: "python",
    languageHint: "Python",
    markerTools: ["ruff", "mypy", "pytest"],
    idioms: PYTHON_PLAN_IDIOMS,
    toolchainSteps: (workspace) =>
      createPythonPlanConfig({ mode: "default" }, "").toolchainSteps(workspace),
  },
  cpp: {
    id: "cpp",
    languageHint: "C++",
    markerTools: ["cmake", "ctest"],
    idioms: CPP_PLAN_IDIOMS,
    toolchainSteps: (workspace) =>
      createCppPlanConfig({ mode: "default" }, "").toolchainSteps(workspace),
  },
  haskell: {
    id: "haskell",
    languageHint: "Haskell",
    markerTools: ["cabal", "hlint", "ghc"],
    idioms: HASKELL_PLAN_IDIOMS,
    toolchainSteps: (workspace) =>
      createHaskellPlanConfig({ mode: "default" }, "").toolchainSteps(workspace),
  },
  julia: {
    id: "julia",
    languageHint: "Julia",
    markerTools: ["julia"],
    idioms: JULIA_PLAN_IDIOMS,
    toolchainSteps: (workspace) =>
      createJuliaPlanConfig({ mode: "default" }, "").toolchainSteps(workspace),
  },
  nix: {
    id: "nix",
    languageHint: "Nix",
    markerTools: ["nix", "nixpkgs-fmt"],
    idioms: NIX_PLAN_IDIOMS,
    isWholeRepoValidator: true,
    toolchainSteps: (workspace) =>
      createNixPlanConfig({ mode: "default" }, "").toolchainSteps(workspace),
  },
  shell: {
    id: "shell",
    languageHint: "Shell",
    markerTools: ["shfmt", "shellcheck"],
    idioms: SHELL_PLAN_IDIOMS,
    isWholeRepoValidator: true,
    toolchainSteps: (workspace) =>
      createShellPlanConfig({ mode: "default" }, "").toolchainSteps(workspace),
  },
};

/**
 * Maps a file extension (including the leading dot, e.g. ".rs") to the
 * toolchain descriptor responsible for it. Extensions absent from this map
 * (e.g. ".md", ".toml", ".json") have no toolchain and route to the
 * no-toolchain floor -- edit-only, no compiler/linter/test/coverage step.
 *
 * Locked route table (memory e06640ae): one canonical toolchain per source
 * extension; `.nix`/`.sh` map to whole-repo validators.
 */
export const EXTENSION_TO_TOOLCHAIN: Readonly<Record<string, LanguageName>> = {
  ".rs": "rust",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".h": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hs": "haskell",
  ".lhs": "haskell",
  ".jl": "julia",
  ".nix": "nix",
  ".sh": "shell",
  ".bash": "shell",
};

/**
 * Union of every marker tool across all registered toolchain descriptors.
 * This is the `candidateTools` argument passed to `devShellPalette` so a
 * workspace's dev environment is probed exactly once per run for every tool
 * any registered toolchain might need.
 */
export const CANDIDATE_TOOLS: readonly string[] = Array.from(
  new Set(Object.values(TOOLCHAIN_DESCRIPTORS).flatMap((descriptor) => descriptor.markerTools)),
);
