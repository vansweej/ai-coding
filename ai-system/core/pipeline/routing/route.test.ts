import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  composeImplementSystem,
  paletteExtensions,
  paletteLanguageHint,
  route,
  runUnionVerification,
} from "./route";

describe("route", () => {
  it("routes .rs to the rust toolchain when cargo is present", () => {
    const palette = new Set(["cargo", "cargo-clippy"]);
    const descriptor = route("src/lib.rs", palette);
    expect(descriptor?.id).toBe("rust");
  });

  it("routes to the floor (null) when the file's toolchain driver is absent from the palette", () => {
    const palette = new Set(["bun"]);
    const descriptor = route("src/lib.rs", palette);
    expect(descriptor).toBeNull();
  });

  it("routes to the floor (null) for extensions with no registered toolchain", () => {
    const palette = new Set(["cargo", "bun", "cmake"]);
    expect(route("README.md", palette)).toBeNull();
    expect(route("package.json", palette)).toBeNull();
    expect(route("Cargo.lock", palette)).toBeNull();
  });

  it("routes .ts/.tsx/.mts/.cts to typescript when bun is present", () => {
    const palette = new Set(["bun"]);
    expect(route("src/index.ts", palette)?.id).toBe("typescript");
    expect(route("src/App.tsx", palette)?.id).toBe("typescript");
    expect(route("src/index.mts", palette)?.id).toBe("typescript");
    expect(route("src/index.cts", palette)?.id).toBe("typescript");
  });

  it("routes python via either ruff or pytest as the driver (OR semantics)", () => {
    expect(route("src/main.py", new Set(["ruff"]))?.id).toBe("python");
    expect(route("src/main.py", new Set(["pytest"]))?.id).toBe("python");
    // mypy alone is a secondary tool, not a driver -- must not route.
    expect(route("src/main.py", new Set(["mypy"]))).toBeNull();
  });

  it("routes shell via either shfmt or shellcheck as the driver (OR semantics)", () => {
    expect(route("deploy.sh", new Set(["shfmt"]))?.id).toBe("shell");
    expect(route("deploy.sh", new Set(["shellcheck"]))?.id).toBe("shell");
  });

  it("routes cpp extensions to the cpp toolchain when cmake is present", () => {
    const palette = new Set(["cmake"]);
    for (const path of ["a.cpp", "a.cc", "a.cxx", "a.h", "a.hpp", "a.hh"]) {
      expect(route(path, palette)?.id).toBe("cpp");
    }
  });

  it("routes haskell/julia/nix extensions to their respective toolchains", () => {
    expect(route("Main.hs", new Set(["cabal"]))?.id).toBe("haskell");
    expect(route("Main.lhs", new Set(["cabal"]))?.id).toBe("haskell");
    expect(route("script.jl", new Set(["julia"]))?.id).toBe("julia");
    expect(route("flake.nix", new Set(["nix"]))?.id).toBe("nix");
  });

  it("is case-insensitive on extension matching", () => {
    expect(route("src/lib.RS", new Set(["cargo"]))?.id).toBe("rust");
  });

  it("returns null for a path with no extension", () => {
    expect(route("Makefile", new Set(["cargo", "bun"]))).toBeNull();
  });

  it("returns null for a path ending in a bare trailing dot", () => {
    expect(route("weirdfile.", new Set(["cargo"]))).toBeNull();
  });

  it("resolves the extension from the final segment for multi-dot filenames", () => {
    expect(route("foo.test.ts", new Set(["bun"]))?.id).toBe("typescript");
  });
});

describe("paletteExtensions", () => {
  it("always includes .md regardless of palette contents", () => {
    expect(paletteExtensions(new Set())).toContain(".md");
    expect(paletteExtensions(new Set(["cargo"]))).toContain(".md");
  });

  it("includes only extensions whose toolchain driver is present", () => {
    const extensions = paletteExtensions(new Set(["cargo"]));
    expect(extensions).toContain(".rs");
    expect(extensions).not.toContain(".ts");
    expect(extensions).not.toContain(".py");
  });

  it("includes every extension for a fully-populated palette", () => {
    const extensions = paletteExtensions(
      new Set(["cargo", "bun", "ruff", "cmake", "cabal", "julia", "nix", "shfmt"]),
    );
    expect(extensions).toEqual(
      expect.arrayContaining([
        ".md",
        ".rs",
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".py",
        ".pyi",
        ".cpp",
        ".cc",
        ".cxx",
        ".h",
        ".hpp",
        ".hh",
        ".hs",
        ".lhs",
        ".jl",
        ".nix",
        ".sh",
        ".bash",
      ]),
    );
  });

  it("returns only .md for an empty palette", () => {
    expect(paletteExtensions(new Set())).toEqual([".md"]);
  });
});

describe("composeImplementSystem", () => {
  it("includes idioms only for available toolchains", () => {
    const prompt = composeImplementSystem(new Set(["cargo"]));
    expect(prompt).toContain("Rust idioms");
    expect(prompt).not.toContain("named exports");
  });

  it("composes a union prompt across multiple available toolchains", () => {
    const prompt = composeImplementSystem(new Set(["cargo", "bun"]));
    expect(prompt).toContain("Rust idioms");
    expect(prompt).toContain("named exports");
    expect(prompt).toContain("Rust/TypeScript");
  });

  it("always includes the floor clause describing edit-only files", () => {
    const prompt = composeImplementSystem(new Set(["cargo"]));
    expect(prompt).toContain("EDIT-ONLY");
  });

  it("falls back to a general-purpose hint and the floor clause when no toolchain is available", () => {
    const prompt = composeImplementSystem(new Set());
    expect(prompt).toContain("general-purpose");
    expect(prompt).toContain("EDIT-ONLY");
  });

  it("produces a valid aider-style SEARCH/REPLACE prompt", () => {
    const prompt = composeImplementSystem(new Set(["cargo"]));
    expect(prompt).toContain("aider-style");
    expect(prompt).toContain("<<<<<<< SEARCH");
    expect(prompt).toContain(">>>>>>> REPLACE");
  });
});

describe("paletteLanguageHint", () => {
  it("returns general-purpose for an empty palette", () => {
    expect(paletteLanguageHint(new Set())).toBe("general-purpose");
  });

  it("returns a single language hint when only one toolchain is available", () => {
    expect(paletteLanguageHint(new Set(["cargo"]))).toBe("Rust");
  });

  it("joins multiple available language hints with a slash", () => {
    expect(paletteLanguageHint(new Set(["cargo", "bun"]))).toBe("Rust/TypeScript");
  });
});

/** Creates a temporary git repository and returns its path. Caller must clean up. */
function makeTempGitRepo(): string {
  const dir = join(tmpdir(), `route-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email "test@example.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  return dir;
}

describe("runUnionVerification", () => {
  it("returns no steps when the workspace is not a git repository", () => {
    const dir = join(
      tmpdir(),
      `route-test-nogit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    try {
      const steps = runUnionVerification(dir, new Set(["cargo", "bun"]));
      expect(steps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns no steps when nothing has been touched", () => {
    const dir = makeTempGitRepo();
    try {
      writeFileSync(join(dir, "committed.rs"), "// initial\n");
      execSync("git add -A", { cwd: dir });
      execSync('git commit -q -m "initial"', { cwd: dir });

      const steps = runUnionVerification(dir, new Set(["cargo"]));
      expect(steps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("routes an unstaged modification to its toolchain's steps, excluding tarpaulin when cargo-tarpaulin is absent from the palette", () => {
    const dir = makeTempGitRepo();
    try {
      writeFileSync(join(dir, "committed.rs"), "// initial\n");
      execSync("git add -A", { cwd: dir });
      execSync('git commit -q -m "initial"', { cwd: dir });

      // Unstaged modification -- shows in `git diff --name-only`.
      writeFileSync(join(dir, "committed.rs"), "// modified\n");

      const steps = runUnionVerification(dir, new Set(["cargo"]));
      expect(steps.map((s) => s.name)).toEqual(
        expect.arrayContaining(["fmt", "check", "clippy", "test"]),
      );
      // cargo-tarpaulin is not in this palette -- gating on a missing tool
      // must not include tarpaulin/coverage steps (see P7: tarpaulin is
      // conditional on BOTH being gated AND being present in the palette).
      expect(steps.map((s) => s.name)).not.toContain("tarpaulin");
      expect(steps.map((s) => s.name)).not.toContain("coverage");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("routes a staged new file to its toolchain's steps", () => {
    const dir = makeTempGitRepo();
    try {
      writeFileSync(join(dir, "README.md"), "# fixture\n");
      execSync("git add -A", { cwd: dir });
      execSync('git commit -q -m "initial"', { cwd: dir });

      // Staged (new, added but not committed) file -- shows via `--staged`.
      writeFileSync(join(dir, "index.ts"), "export const x = 1;\n");
      execSync("git add index.ts", { cwd: dir });

      const steps = runUnionVerification(dir, new Set(["bun"]));
      expect(steps.map((s) => s.name)).toEqual(
        expect.arrayContaining(["typecheck", "lint", "test"]),
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("produces the union of steps across touched files of different toolchains, deduped by step name", () => {
    const dir = makeTempGitRepo();
    try {
      writeFileSync(join(dir, "a.rs"), "// initial\n");
      writeFileSync(join(dir, "b.ts"), "export const x = 1;\n");
      execSync("git add -A", { cwd: dir });
      execSync('git commit -q -m "initial"', { cwd: dir });

      writeFileSync(join(dir, "a.rs"), "// modified\n");
      writeFileSync(join(dir, "b.ts"), "export const x = 2;\n");

      const steps = runUnionVerification(dir, new Set(["cargo", "bun"]));
      const names = steps.map((s) => s.name);
      expect(names).toEqual(
        expect.arrayContaining(["fmt", "check", "clippy", "typecheck", "lint"]),
      );
      // "test" is a step name shared by both rust and typescript toolchains --
      // deduped-by-step-name means it appears exactly once in the union.
      expect(names.filter((n) => n === "test").length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("contributes nothing when a touched file routes to the floor (no matching toolchain)", () => {
    const dir = makeTempGitRepo();
    try {
      writeFileSync(join(dir, "README.md"), "# initial\n");
      execSync("git add -A", { cwd: dir });
      execSync('git commit -q -m "initial"', { cwd: dir });

      writeFileSync(join(dir, "README.md"), "# modified\n");

      const steps = runUnionVerification(dir, new Set(["cargo", "bun"]));
      expect(steps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("contributes nothing when the touched file's toolchain driver is absent from the palette", () => {
    const dir = makeTempGitRepo();
    try {
      writeFileSync(join(dir, "a.rs"), "// initial\n");
      execSync("git add -A", { cwd: dir });
      execSync('git commit -q -m "initial"', { cwd: dir });

      writeFileSync(join(dir, "a.rs"), "// modified\n");

      // bun present, but no rust driver -- a.rs's toolchain is unavailable.
      const steps = runUnionVerification(dir, new Set(["bun"]));
      expect(steps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  describe("coverage gate under per-file routing (P7)", () => {
    it("fires the coverage gate for a routed rust file when Coverage:N% is set and cargo-tarpaulin is in the palette", () => {
      const dir = makeTempGitRepo();
      try {
        writeFileSync(join(dir, "a.rs"), "// initial\n");
        execSync("git add -A", { cwd: dir });
        execSync('git commit -q -m "initial"', { cwd: dir });
        writeFileSync(join(dir, "a.rs"), "// modified\n");

        const steps = runUnionVerification(
          dir,
          new Set(["cargo", "cargo-tarpaulin"]),
          { mode: "threshold", percent: 95 },
          "",
        );
        expect(steps.map((s) => s.name)).toEqual(expect.arrayContaining(["tarpaulin", "coverage"]));
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it("omits the coverage gate for a routed rust file when Coverage: skip is set, even with cargo-tarpaulin in the palette", () => {
      const dir = makeTempGitRepo();
      try {
        writeFileSync(join(dir, "a.rs"), "// initial\n");
        execSync("git add -A", { cwd: dir });
        execSync('git commit -q -m "initial"', { cwd: dir });
        writeFileSync(join(dir, "a.rs"), "// modified\n");

        const steps = runUnionVerification(
          dir,
          new Set(["cargo", "cargo-tarpaulin"]),
          { mode: "skip" },
          "",
        );
        expect(steps.map((s) => s.name)).not.toContain("tarpaulin");
        expect(steps.map((s) => s.name)).not.toContain("coverage");
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it("omits the coverage gate for a routed rust file when gated but cargo-tarpaulin is absent from the palette", () => {
      const dir = makeTempGitRepo();
      try {
        writeFileSync(join(dir, "a.rs"), "// initial\n");
        execSync("git add -A", { cwd: dir });
        execSync('git commit -q -m "initial"', { cwd: dir });
        writeFileSync(join(dir, "a.rs"), "// modified\n");

        // cargo present (so rust routes), but cargo-tarpaulin is NOT --
        // tarpaulin must be conditional on BOTH gated AND tarpaulin-in-palette.
        const steps = runUnionVerification(
          dir,
          new Set(["cargo"]),
          { mode: "threshold", percent: 95 },
          "",
        );
        expect(steps.map((s) => s.name)).not.toContain("tarpaulin");
        expect(steps.map((s) => s.name)).not.toContain("coverage");
      } finally {
        rmSync(dir, { recursive: true });
      }
    });

    it("never gates on coverage for a docs-only phase (touched file routes to the floor)", () => {
      const dir = makeTempGitRepo();
      try {
        writeFileSync(join(dir, "README.md"), "# initial\n");
        execSync("git add -A", { cwd: dir });
        execSync('git commit -q -m "initial"', { cwd: dir });
        writeFileSync(join(dir, "README.md"), "# modified\n");

        // Even with cargo/cargo-tarpaulin available and a gated threshold,
        // a docs-only touched file contributes NO steps at all -- there is
        // no rust file in this phase's diff to route to the rust toolchain.
        const steps = runUnionVerification(
          dir,
          new Set(["cargo", "cargo-tarpaulin"]),
          { mode: "threshold", percent: 95 },
          "",
        );
        expect(steps).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true });
      }
    });
  });
});
