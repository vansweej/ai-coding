import { describe, expect, it } from "bun:test";

import { composeImplementSystem, paletteExtensions, route } from "./route";

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
