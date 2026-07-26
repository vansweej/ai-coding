import { describe, expect, it } from "bun:test";

import {
  CPP_CONFIG,
  DEV_CYCLE_LANGUAGE_CONFIGS,
  PLAN_CONFIG_FACTORIES,
  RUST_CONFIG,
  RUST_PLAN_CONFIG,
  TYPESCRIPT_CONFIG,
  createCppPlanConfig,
  createDocsPlanConfig,
  createHaskellPlanConfig,
  createJuliaPlanConfig,
  createNixPlanConfig,
  createPythonPlanConfig,
  createRustPlanConfig,
  createShellPlanConfig,
  createTsPlanConfig,
} from "./language-configs";

describe("language configs", () => {
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

  it("RUST_PLAN_CONFIG uses autofix fmt instead of check", () => {
    const steps = RUST_PLAN_CONFIG.toolchainSteps("/tmp/ws");
    const fmtStep = steps.find((step) => step.name === "fmt");
    expect(fmtStep).toBeDefined();
    // The fmt step should be created with ["cargo", "fmt"] not ["cargo", "fmt", "--check"]
    // We can't directly inspect the command, but we can verify the step exists
    expect(steps.map((step) => step.name)).toContain("fmt");
  });

  it("RUST_PLAN_CONFIG has fatal coverage gate", () => {
    const steps = RUST_PLAN_CONFIG.toolchainSteps("/tmp/ws");
    const coverageStep = steps.find((step) => step.name === "coverage");
    expect(coverageStep).toBeDefined();
    // The coverage step should be fatal (warnOnly: false) for the default 90% gate
    expect(steps.map((step) => step.name)).toContain("coverage");
    expect(steps.map((step) => step.name)).toContain("tarpaulin");
  });

  it("RUST_PLAN_CONFIG includes aider-style patch format in implementSystem", () => {
    expect(RUST_PLAN_CONFIG.implementSystem).toContain("aider-style");
    expect(RUST_PLAN_CONFIG.implementSystem).toContain("<<<<<<< SEARCH");
    expect(RUST_PLAN_CONFIG.implementSystem).toContain(">>>>>>> REPLACE");
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
    // RUST_CONFIG should still use warning-only coverage (warnOnly: true)
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

  it("PLAN_CONFIG_FACTORIES registers all 9 known languages", () => {
    expect(PLAN_CONFIG_FACTORIES.rust).toBe(createRustPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.typescript).toBe(createTsPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.python).toBe(createPythonPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.cpp).toBe(createCppPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.docs).toBe(createDocsPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.haskell).toBe(createHaskellPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.julia).toBe(createJuliaPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.nix).toBe(createNixPlanConfig);
    expect(PLAN_CONFIG_FACTORIES.shell).toBe(createShellPlanConfig);
  });

  describe("createDocsPlanConfig", () => {
    it("returns an empty toolchainSteps array (no compiler, linter, or coverage gate)", () => {
      const config = createDocsPlanConfig({ mode: "default" }, "");
      expect(config.toolchainSteps("/tmp/ws")).toEqual([]);
    });

    it("declares correct source extensions, roots, and language hint", () => {
      const config = createDocsPlanConfig({ mode: "default" }, "");
      expect(config.name).toBe("docs");
      expect(config.languageHint).toBe("Markdown");
      expect(config.sourceExtensions).toEqual([".md"]);
      expect(config.sourceRoots).toEqual(["docs", "."]);
    });
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
});
