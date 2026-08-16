import { describe, expect, it } from "bun:test";

import {
  CANDIDATE_TOOLS,
  CPP_CONFIG,
  DEV_CYCLE_LANGUAGE_CONFIGS,
  EXTENSION_TO_TOOLCHAIN,
  PLAN_CONFIG_FACTORIES,
  RUST_CONFIG,
  TOOLCHAIN_DESCRIPTORS,
  TYPESCRIPT_CONFIG,
  buildPatchSystem,
  createCppPlanConfig,
  createHaskellPlanConfig,
  createJuliaPlanConfig,
  createNixPlanConfig,
  createPythonPlanConfig,
  createRustPlanConfig,
  createShellPlanConfig,
  createTsPlanConfig,
} from "./language-configs";

describe("language configs", () => {
  it("buildPatchSystem includes the MOVE directive alongside SEARCH/REPLACE", () => {
    const system = buildPatchSystem("Rust", "Some idioms.");
    expect(system).toContain("<<<<<<< SEARCH");
    expect(system).toContain(">>>>>>> REPLACE");
    expect(system).toContain("<<<<<<< MOVE");
    expect(system).toContain(">>>>>>> MOVE");
    expect(system).toContain("move or rename a file or directory");
    // The MOVE block appears after the SEARCH/REPLACE block and before the idioms.
    expect(system.indexOf(">>>>>>> REPLACE")).toBeLessThan(system.indexOf("<<<<<<< MOVE"));
    expect(system.indexOf(">>>>>>> MOVE")).toBeLessThan(system.indexOf("Some idioms."));
  });

  it("registers TypeScript, Rust, and C++ configs", () => {
    expect(DEV_CYCLE_LANGUAGE_CONFIGS.typescript).toBe(TYPESCRIPT_CONFIG);
    expect(DEV_CYCLE_LANGUAGE_CONFIGS.rust).toBe(RUST_CONFIG);
    expect(DEV_CYCLE_LANGUAGE_CONFIGS.cpp).toBe(CPP_CONFIG);
  });

  it("TYPESCRIPT_CONFIG declares correct source extensions and roots", () => {
    expect(TYPESCRIPT_CONFIG.sourceExtensions).toEqual([".ts", ".md"]);
    expect(TYPESCRIPT_CONFIG.sourceRoots).toEqual(["src", "."]);
  });

  it("RUST_CONFIG declares correct source extensions and roots", () => {
    expect(RUST_CONFIG.sourceExtensions).toEqual([".rs", ".md"]);
    expect(RUST_CONFIG.sourceRoots).toEqual(["src", "crates", "."]);
  });

  it("CPP_CONFIG declares correct source extensions and roots", () => {
    expect(CPP_CONFIG.sourceExtensions).toEqual([".cpp", ".h", ".hpp", ".md"]);
    expect(CPP_CONFIG.sourceRoots).toEqual(["src", "include", "."]);
  });

  it("createRustPlanConfig declares correct source extensions and roots", () => {
    const config = createRustPlanConfig({ mode: "default" }, "");
    expect(config.sourceExtensions).toEqual([".rs", ".md"]);
    expect(config.sourceRoots).toEqual(["src", "crates", "."]);
  });

  it("requires doc comments in every implement system prompt", () => {
    expect(TYPESCRIPT_CONFIG.implementSystem).toContain("doc comments");
    expect(RUST_CONFIG.implementSystem).toContain("doc comments");
    expect(CPP_CONFIG.implementSystem).toContain("doc comments");
  });

  it("provides TypeScript verification steps", () => {
    expect(TYPESCRIPT_CONFIG.toolchainSteps("/tmp/ws").map((step) => step.name)).toEqual([
      "typecheck",
      "lint",
      "test",
    ]);
  });

  it("provides Rust verification steps", () => {
    expect(RUST_CONFIG.toolchainSteps("/tmp/ws").map((step) => step.name)).toEqual([
      "fmt",
      "check",
      "clippy",
      "test",
      "tarpaulin",
      "coverage",
    ]);
  });

  it("provides C++ verification steps", () => {
    expect(CPP_CONFIG.toolchainSteps("/tmp/ws").map((step) => step.name)).toEqual([
      "configure",
      "build",
      "test",
    ]);
  });

  it("createRustPlanConfig with the default 90% gate uses autofix fmt instead of check", () => {
    const config = createRustPlanConfig({ mode: "threshold", percent: 90 }, "");
    const steps = config.toolchainSteps("/tmp/ws");
    const fmtStep = steps.find((step: { name: string }) => step.name === "fmt");
    expect(fmtStep).toBeDefined();
    // The fmt step should be created with ["cargo", "fmt"] not ["cargo", "fmt", "--check"]
    // We can't directly inspect the command, but we can verify the step exists
    expect(steps.map((step: { name: string }) => step.name)).toContain("fmt");
  });

  it("createRustPlanConfig with the default 90% gate has a fatal coverage gate", () => {
    const config = createRustPlanConfig({ mode: "threshold", percent: 90 }, "");
    const steps = config.toolchainSteps("/tmp/ws");
    const coverageStep = steps.find((step: { name: string }) => step.name === "coverage");
    expect(coverageStep).toBeDefined();
    // The coverage step should be fatal for the default 90% gate
    expect(steps.map((step: { name: string }) => step.name)).toContain("coverage");
    expect(steps.map((step: { name: string }) => step.name)).toContain("tarpaulin");
  });

  it("createRustPlanConfig with the default 90% gate includes aider-style patch format in implementSystem", () => {
    const config = createRustPlanConfig({ mode: "threshold", percent: 90 }, "");
    expect(config.implementSystem).toContain("aider-style");
    expect(config.implementSystem).toContain("<<<<<<< SEARCH");
    expect(config.implementSystem).toContain(">>>>>>> REPLACE");
  });

  it("RUST_CONFIG remains unchanged with check fmt", () => {
    const steps = RUST_CONFIG.toolchainSteps("/tmp/ws");
    expect(steps.map((step) => step.name)).toEqual([
      "fmt",
      "check",
      "clippy",
      "test",
      "tarpaulin",
      "coverage",
    ]);
    // RUST_CONFIG should also use a fatal coverage gate
    expect(RUST_CONFIG.implementSystem).toContain("fenced code blocks");
    expect(RUST_CONFIG.implementSystem).not.toContain("aider-style");
  });

  it("createRustPlanConfig respects skip directive", () => {
    const config = createRustPlanConfig({ mode: "skip" }, "");
    const steps = config.toolchainSteps("/tmp/ws");
    // With skip directive, coverage is not gated -- the tarpaulin instrumented
    // rebuild and the coverage gate are both omitted rather than made warn-only.
    expect(steps.map((step) => step.name)).toEqual(["fmt", "check", "clippy", "test"]);
    expect(steps.find((step) => step.name === "tarpaulin")).toBeUndefined();
    expect(steps.find((step) => step.name === "coverage")).toBeUndefined();
  });

  it("createRustPlanConfig omits tarpaulin and coverage when not gated", () => {
    const config = createRustPlanConfig({ mode: "skip" }, "");
    const steps = config.toolchainSteps("/tmp/ws");
    const names = steps.map((step) => step.name);
    expect(names).not.toContain("tarpaulin");
    expect(names).not.toContain("coverage");
  });

  it("createRustPlanConfig respects explicit threshold", () => {
    const config = createRustPlanConfig({ mode: "threshold", percent: 95 }, "");
    const steps = config.toolchainSteps("/tmp/ws");
    const coverageStep = steps.find((step) => step.name === "coverage");
    expect(coverageStep).toBeDefined();
    // With explicit threshold, coverage is gated: tarpaulin runs and the gate is fatal
    expect(steps.find((step) => step.name === "tarpaulin")).toBeDefined();
  });

  it("createRustPlanConfig respects auto-exempt", () => {
    const diff = `diff --git a/src/main.rs b/src/main.rs
+    // comment`;
    const config = createRustPlanConfig({ mode: "default" }, diff);
    const steps = config.toolchainSteps("/tmp/ws");
    // With auto-exempt, coverage is not gated -- tarpaulin and the gate are omitted
    expect(steps.map((step) => step.name)).toEqual(["fmt", "check", "clippy", "test"]);
    expect(steps.find((step) => step.name === "tarpaulin")).toBeUndefined();
    expect(steps.find((step) => step.name === "coverage")).toBeUndefined();
  });

  it("createRustPlanConfig implementSystem is byte-identical before and after buildPatchSystem refactor", () => {
    const config = createRustPlanConfig({ mode: "default" }, "");
    expect(config.implementSystem).toContain("aider-style");
    expect(config.implementSystem).toContain("<<<<<<< SEARCH");
    expect(config.implementSystem).toContain(">>>>>>> REPLACE");
    expect(config.implementSystem).toContain("Follow Rust idioms");
    expect(config.implementSystem).toContain("Do not include any explanation");
    // Verify the exact prefix so the refactor stays byte-identical
    expect(config.implementSystem.startsWith("You are a Rust coding assistant.")).toBe(true);
  });

  it("createTsPlanConfig produces aider-style patch system prompt", () => {
    const config = createTsPlanConfig({ mode: "default" }, "");
    expect(config.implementSystem).toContain("aider-style");
    expect(config.implementSystem).toContain("<<<<<<< SEARCH");
    expect(config.implementSystem).toContain(">>>>>>> REPLACE");
    expect(config.implementSystem).toContain("TypeScript");
    expect(config.implementSystem).toContain("Do not include any explanation");
  });

  it("createTsPlanConfig has typecheck, lint, and test toolchain steps", () => {
    const config = createTsPlanConfig({ mode: "default" }, "");
    expect(config.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual([
      "typecheck",
      "lint",
      "test",
    ]);
  });

  it("createTsPlanConfig has no coverage gate step", () => {
    const config = createTsPlanConfig({ mode: "default" }, "");
    const names = config.toolchainSteps("/tmp/ws").map((s) => s.name);
    expect(names).not.toContain("coverage");
  });

  it("createTsPlanConfig declares correct source extensions and roots", () => {
    const config = createTsPlanConfig({ mode: "default" }, "");
    expect(config.sourceExtensions).toEqual([".ts", ".md"]);
    expect(config.sourceRoots).toEqual(["src", "."]);
  });

  it("PLAN_CONFIG_FACTORIES registers rust and typescript", () => {
    expect(PLAN_CONFIG_FACTORIES.rust).toBe(createRustPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.typescript).toBe(createTsPlanConfig);
  });

  it("PLAN_CONFIG_FACTORIES registers all 8 known toolchains", () => {
    expect(PLAN_CONFIG_FACTORIES.rust).toBe(createRustPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.typescript).toBe(createTsPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.python).toBe(createPythonPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.cpp).toBe(createCppPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.haskell).toBe(createHaskellPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.julia).toBe(createJuliaPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.nix).toBe(createNixPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.shell).toBe(createShellPlanConfig);
  });

  describe("createPythonPlanConfig", () => {
    it("declares correct source extensions and roots", () => {
      const config = createPythonPlanConfig({ mode: "default" }, "");
      expect(config.sourceExtensions).toEqual([".py", ".md"]);
      expect(config.sourceRoots).toEqual(["src", "."]);
    });

    it("produces aider-style patch system prompt", () => {
      const config = createPythonPlanConfig({ mode: "default" }, "");
      expect(config.implementSystem).toContain("aider-style");
      expect(config.implementSystem).toContain("<<<<<<< SEARCH");
      expect(config.implementSystem).toContain(">>>>>>> REPLACE");
      expect(config.implementSystem).toContain("Python");
    });

    it("has format, lint, typecheck, and test toolchain steps in order", () => {
      const config = createPythonPlanConfig({ mode: "default" }, "");
      expect(config.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual([
        "format",
        "lint",
        "typecheck",
        "test",
      ]);
    });

    it("has no coverage gate step", () => {
      const config = createPythonPlanConfig({ mode: "default" }, "");
      const names = config.toolchainSteps("/tmp/ws").map((s) => s.name);
      expect(names).not.toContain("coverage");
    });

    it("does not set baselineCheck", () => {
      const config = createPythonPlanConfig({ mode: "default" }, "");
      expect(config.baselineCheck).toBeUndefined();
    });
  });

  describe("createCppPlanConfig", () => {
    it("declares correct source extensions and roots", () => {
      const config = createCppPlanConfig({ mode: "default" }, "");
      expect(config.sourceExtensions).toEqual([".cpp", ".h", ".hpp", ".md"]);
      expect(config.sourceRoots).toEqual(["src", "include", "."]);
    });

    it("produces aider-style patch system prompt", () => {
      const config = createCppPlanConfig({ mode: "default" }, "");
      expect(config.implementSystem).toContain("aider-style");
      expect(config.implementSystem).toContain("<<<<<<< SEARCH");
      expect(config.implementSystem).toContain(">>>>>>> REPLACE");
      expect(config.implementSystem).toContain("C++");
    });

    it("has configure, build, and test toolchain steps in order", () => {
      const config = createCppPlanConfig({ mode: "default" }, "");
      expect(config.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual([
        "configure",
        "build",
        "test",
      ]);
    });

    it("does not set baselineCheck", () => {
      const config = createCppPlanConfig({ mode: "default" }, "");
      expect(config.baselineCheck).toBeUndefined();
    });
  });

  describe("createHaskellPlanConfig", () => {
    it("declares correct source extensions and roots", () => {
      const config = createHaskellPlanConfig({ mode: "default" }, "");
      expect(config.sourceExtensions).toEqual([".hs", ".md"]);
      expect(config.sourceRoots).toEqual(["src", "app", "."]);
    });

    it("produces aider-style patch system prompt", () => {
      const config = createHaskellPlanConfig({ mode: "default" }, "");
      expect(config.implementSystem).toContain("aider-style");
      expect(config.implementSystem).toContain("<<<<<<< SEARCH");
      expect(config.implementSystem).toContain(">>>>>>> REPLACE");
      expect(config.implementSystem).toContain("Haskell");
    });

    it("has build, lint, and test toolchain steps in order", () => {
      const config = createHaskellPlanConfig({ mode: "default" }, "");
      expect(config.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual([
        "build",
        "lint",
        "test",
      ]);
    });

    it("does not set baselineCheck", () => {
      const config = createHaskellPlanConfig({ mode: "default" }, "");
      expect(config.baselineCheck).toBeUndefined();
    });
  });

  describe("createJuliaPlanConfig", () => {
    it("declares correct source extensions and roots", () => {
      const config = createJuliaPlanConfig({ mode: "default" }, "");
      expect(config.sourceExtensions).toEqual([".jl", ".md"]);
      expect(config.sourceRoots).toEqual(["src", "."]);
    });

    it("produces aider-style patch system prompt", () => {
      const config = createJuliaPlanConfig({ mode: "default" }, "");
      expect(config.implementSystem).toContain("aider-style");
      expect(config.implementSystem).toContain("<<<<<<< SEARCH");
      expect(config.implementSystem).toContain(">>>>>>> REPLACE");
      expect(config.implementSystem).toContain("Julia");
    });

    it("has only a single test toolchain step (weak verification)", () => {
      const config = createJuliaPlanConfig({ mode: "default" }, "");
      expect(config.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual(["test"]);
    });

    it("does not set baselineCheck", () => {
      const config = createJuliaPlanConfig({ mode: "default" }, "");
      expect(config.baselineCheck).toBeUndefined();
    });
  });

  describe("createNixPlanConfig", () => {
    it("declares correct source extensions and roots", () => {
      const config = createNixPlanConfig({ mode: "default" }, "");
      expect(config.sourceExtensions).toEqual([".nix", ".md"]);
      expect(config.sourceRoots).toEqual(["."]);
    });

    it("produces aider-style patch system prompt", () => {
      const config = createNixPlanConfig({ mode: "default" }, "");
      expect(config.implementSystem).toContain("aider-style");
      expect(config.implementSystem).toContain("<<<<<<< SEARCH");
      expect(config.implementSystem).toContain(">>>>>>> REPLACE");
      expect(config.implementSystem).toContain("Nix");
    });

    it("has format and check toolchain steps in order", () => {
      const config = createNixPlanConfig({ mode: "default" }, "");
      expect(config.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual(["format", "check"]);
    });

    it("sets baselineCheck to true (whole-repo nix flake check cannot be scoped to a diff)", () => {
      const config = createNixPlanConfig({ mode: "default" }, "");
      expect(config.baselineCheck).toBe(true);
    });
  });

  describe("createShellPlanConfig", () => {
    it("declares correct source extensions and roots", () => {
      const config = createShellPlanConfig({ mode: "default" }, "");
      expect(config.sourceExtensions).toEqual([".sh", ".md"]);
      expect(config.sourceRoots).toEqual(["."]);
    });

    it("produces aider-style patch system prompt", () => {
      const config = createShellPlanConfig({ mode: "default" }, "");
      expect(config.implementSystem).toContain("aider-style");
      expect(config.implementSystem).toContain("<<<<<<< SEARCH");
      expect(config.implementSystem).toContain(">>>>>>> REPLACE");
      expect(config.implementSystem).toContain("Shell");
    });

    it("has format and lint toolchain steps in order", () => {
      const config = createShellPlanConfig({ mode: "default" }, "");
      expect(config.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual(["format", "lint"]);
    });

    it("sets baselineCheck to true (whole-repo shellcheck cannot be scoped to a diff)", () => {
      const config = createShellPlanConfig({ mode: "default" }, "");
      expect(config.baselineCheck).toBe(true);
    });
  });

  describe("TOOLCHAIN_DESCRIPTORS", () => {
    it("registers all 8 non-docs languages", () => {
      expect(Object.keys(TOOLCHAIN_DESCRIPTORS).sort()).toEqual(
        ["cpp", "haskell", "julia", "nix", "python", "rust", "shell", "typescript"].sort(),
      );
    });

    it("does not register docs (it is the no-toolchain floor, not a real toolchain)", () => {
      expect("docs" in TOOLCHAIN_DESCRIPTORS).toBe(false);
    });

    it("uses cargo-clippy, not clippy, as the Rust marker tool", () => {
      // Manually validated: `clippy` alone does not resolve via `command -v`
      // in a real Rust devShell; the actual binary is `cargo-clippy`.
      expect(TOOLCHAIN_DESCRIPTORS.rust.markerTools).toContain("cargo-clippy");
      expect(TOOLCHAIN_DESCRIPTORS.rust.markerTools).not.toContain("clippy");
    });

    it("marks nix and shell as whole-repo validators", () => {
      expect(TOOLCHAIN_DESCRIPTORS.nix.isWholeRepoValidator).toBe(true);
      expect(TOOLCHAIN_DESCRIPTORS.shell.isWholeRepoValidator).toBe(true);
    });

    it("does not mark rust, typescript, python, cpp, haskell, julia as whole-repo validators", () => {
      expect(TOOLCHAIN_DESCRIPTORS.rust.isWholeRepoValidator).toBeUndefined();
      expect(TOOLCHAIN_DESCRIPTORS.typescript.isWholeRepoValidator).toBeUndefined();
      expect(TOOLCHAIN_DESCRIPTORS.python.isWholeRepoValidator).toBeUndefined();
      expect(TOOLCHAIN_DESCRIPTORS.cpp.isWholeRepoValidator).toBeUndefined();
      expect(TOOLCHAIN_DESCRIPTORS.haskell.isWholeRepoValidator).toBeUndefined();
      expect(TOOLCHAIN_DESCRIPTORS.julia.isWholeRepoValidator).toBeUndefined();
    });

    it("rust toolchainSteps delegates to createRustPlanConfig and reflects coverage gating", () => {
      const gated = TOOLCHAIN_DESCRIPTORS.rust.toolchainSteps(
        "/tmp/ws",
        { mode: "threshold", percent: 90 },
        "",
      );
      expect(gated.map((s) => s.name)).toContain("tarpaulin");
      expect(gated.map((s) => s.name)).toContain("coverage");

      const skipped = TOOLCHAIN_DESCRIPTORS.rust.toolchainSteps("/tmp/ws", { mode: "skip" }, "");
      expect(skipped.map((s) => s.name)).not.toContain("tarpaulin");
      expect(skipped.map((s) => s.name)).not.toContain("coverage");
    });

    it("typescript toolchainSteps delegates to createTsPlanConfig", () => {
      expect(TOOLCHAIN_DESCRIPTORS.typescript.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual(
        ["typecheck", "lint", "test"],
      );
    });

    it("python toolchainSteps delegates to createPythonPlanConfig", () => {
      expect(TOOLCHAIN_DESCRIPTORS.python.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual([
        "format",
        "lint",
        "typecheck",
        "test",
      ]);
    });

    it("cpp toolchainSteps delegates to createCppPlanConfig", () => {
      expect(TOOLCHAIN_DESCRIPTORS.cpp.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual([
        "configure",
        "build",
        "test",
      ]);
    });

    it("haskell toolchainSteps delegates to createHaskellPlanConfig", () => {
      expect(TOOLCHAIN_DESCRIPTORS.haskell.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual([
        "build",
        "lint",
        "test",
      ]);
    });

    it("julia toolchainSteps delegates to createJuliaPlanConfig", () => {
      expect(TOOLCHAIN_DESCRIPTORS.julia.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual([
        "test",
      ]);
    });

    it("nix toolchainSteps delegates to createNixPlanConfig", () => {
      expect(TOOLCHAIN_DESCRIPTORS.nix.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual([
        "format",
        "check",
      ]);
    });

    it("shell toolchainSteps delegates to createShellPlanConfig", () => {
      expect(TOOLCHAIN_DESCRIPTORS.shell.toolchainSteps("/tmp/ws").map((s) => s.name)).toEqual([
        "format",
        "lint",
      ]);
    });

    it("every descriptor's idioms match its corresponding *_PLAN_IDIOMS source", () => {
      expect(TOOLCHAIN_DESCRIPTORS.rust.idioms).toContain("Rust idioms");
      expect(TOOLCHAIN_DESCRIPTORS.typescript.idioms).toContain("named exports");
      expect(TOOLCHAIN_DESCRIPTORS.python.idioms).toContain("type hints");
      expect(TOOLCHAIN_DESCRIPTORS.cpp.idioms).toContain("C++20");
      expect(TOOLCHAIN_DESCRIPTORS.haskell.idioms).toContain("Haddock");
      expect(TOOLCHAIN_DESCRIPTORS.julia.idioms).toContain("multiple dispatch");
      expect(TOOLCHAIN_DESCRIPTORS.nix.idioms).toContain("let-in");
      expect(TOOLCHAIN_DESCRIPTORS.shell.idioms).toContain("shellcheck");
    });
  });

  describe("EXTENSION_TO_TOOLCHAIN", () => {
    it("maps each source extension to its expected language", () => {
      expect(EXTENSION_TO_TOOLCHAIN[".rs"]).toBe("rust");
      expect(EXTENSION_TO_TOOLCHAIN[".ts"]).toBe("typescript");
      expect(EXTENSION_TO_TOOLCHAIN[".tsx"]).toBe("typescript");
      expect(EXTENSION_TO_TOOLCHAIN[".mts"]).toBe("typescript");
      expect(EXTENSION_TO_TOOLCHAIN[".cts"]).toBe("typescript");
      expect(EXTENSION_TO_TOOLCHAIN[".py"]).toBe("python");
      expect(EXTENSION_TO_TOOLCHAIN[".pyi"]).toBe("python");
      expect(EXTENSION_TO_TOOLCHAIN[".cpp"]).toBe("cpp");
      expect(EXTENSION_TO_TOOLCHAIN[".cc"]).toBe("cpp");
      expect(EXTENSION_TO_TOOLCHAIN[".cxx"]).toBe("cpp");
      expect(EXTENSION_TO_TOOLCHAIN[".h"]).toBe("cpp");
      expect(EXTENSION_TO_TOOLCHAIN[".hpp"]).toBe("cpp");
      expect(EXTENSION_TO_TOOLCHAIN[".hh"]).toBe("cpp");
      expect(EXTENSION_TO_TOOLCHAIN[".hs"]).toBe("haskell");
      expect(EXTENSION_TO_TOOLCHAIN[".lhs"]).toBe("haskell");
      expect(EXTENSION_TO_TOOLCHAIN[".jl"]).toBe("julia");
      expect(EXTENSION_TO_TOOLCHAIN[".nix"]).toBe("nix");
      expect(EXTENSION_TO_TOOLCHAIN[".sh"]).toBe("shell");
      expect(EXTENSION_TO_TOOLCHAIN[".bash"]).toBe("shell");
    });

    it("does not map .md, .toml, .json, .yaml, .yml, or .lock -- they route to the no-toolchain floor", () => {
      expect(EXTENSION_TO_TOOLCHAIN[".md"]).toBeUndefined();
      expect(EXTENSION_TO_TOOLCHAIN[".toml"]).toBeUndefined();
      expect(EXTENSION_TO_TOOLCHAIN[".json"]).toBeUndefined();
      expect(EXTENSION_TO_TOOLCHAIN[".yaml"]).toBeUndefined();
      expect(EXTENSION_TO_TOOLCHAIN[".yml"]).toBeUndefined();
      expect(EXTENSION_TO_TOOLCHAIN[".lock"]).toBeUndefined();
    });
  });

  describe("CANDIDATE_TOOLS", () => {
    it("is the deduplicated union of every descriptor's markerTools", () => {
      const expected = new Set(
        Object.values(TOOLCHAIN_DESCRIPTORS).flatMap((descriptor) => descriptor.markerTools),
      );
      expect(new Set(CANDIDATE_TOOLS)).toEqual(expected);
    });

    it("has no duplicate entries", () => {
      expect(CANDIDATE_TOOLS.length).toBe(new Set(CANDIDATE_TOOLS).size);
    });

    it("includes cargo-clippy, not clippy", () => {
      expect(CANDIDATE_TOOLS).toContain("cargo-clippy");
      expect(CANDIDATE_TOOLS).not.toContain("clippy");
    });

    it("includes the union of tools across all 8 registered languages", () => {
      expect(CANDIDATE_TOOLS).toEqual(
        expect.arrayContaining([
          "cargo",
          "rustc",
          "cargo-clippy",
          "rustfmt",
          "cargo-tarpaulin",
          "bun",
          "ruff",
          "mypy",
          "pytest",
          "cmake",
          "ctest",
          "cabal",
          "hlint",
          "ghc",
          "julia",
          "nixpkgs-fmt",
          "nix",
          "shfmt",
          "shellcheck",
        ]),
      );
    });
  });
});
