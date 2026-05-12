import { describe, expect, it } from "bun:test";

import { detectLanguage } from "./detect-language";

describe("detectLanguage", () => {
  it("detects TypeScript from .ts extension", () => {
    expect(detectLanguage("src/store/lance-store.ts")).toBe("typescript");
  });

  it("detects TypeScript from .tsx extension", () => {
    expect(detectLanguage("components/App.tsx")).toBe("typescript");
  });

  it("detects TypeScript from .mts extension", () => {
    expect(detectLanguage("src/main.mts")).toBe("typescript");
  });

  it("detects TypeScript from .cts extension", () => {
    expect(detectLanguage("src/main.cts")).toBe("typescript");
  });

  it("detects JavaScript from .js extension", () => {
    expect(detectLanguage("index.js")).toBe("javascript");
  });

  it("detects JavaScript from .mjs extension", () => {
    expect(detectLanguage("module.mjs")).toBe("javascript");
  });

  it("detects JavaScript from .jsx extension", () => {
    expect(detectLanguage("component.jsx")).toBe("javascript");
  });

  it("detects Rust from .rs extension", () => {
    expect(detectLanguage("src/lib.rs")).toBe("rust");
  });

  it("detects C from .c extension", () => {
    expect(detectLanguage("main.c")).toBe("c");
  });

  it("detects C++ from .h extension (headers use cpp grammar for template/class/namespace support)", () => {
    expect(detectLanguage("include/api.h")).toBe("cpp");
  });

  it("detects C++ from .cpp extension", () => {
    expect(detectLanguage("src/parser.cpp")).toBe("cpp");
  });

  it("detects C++ from .cc extension", () => {
    expect(detectLanguage("src/parser.cc")).toBe("cpp");
  });

  it("detects C++ from .hpp extension", () => {
    expect(detectLanguage("include/parser.hpp")).toBe("cpp");
  });

  it("detects Python from .py extension", () => {
    expect(detectLanguage("scripts/build.py")).toBe("python");
  });

  it("detects Haskell from .hs extension", () => {
    expect(detectLanguage("Main.hs")).toBe("haskell");
  });

  it("detects Lua from .lua extension", () => {
    expect(detectLanguage("init.lua")).toBe("lua");
  });

  it("detects Julia from .jl extension", () => {
    expect(detectLanguage("src/solver.jl")).toBe("julia");
  });

  it("returns null for .nix files (uses fallback chunker)", () => {
    expect(detectLanguage("flake.nix")).toBeNull();
  });

  it("returns null for .toml files", () => {
    expect(detectLanguage("Cargo.toml")).toBeNull();
  });

  it("returns null for .json files", () => {
    expect(detectLanguage("package.json")).toBeNull();
  });

  it("returns null for .md files", () => {
    expect(detectLanguage("README.md")).toBeNull();
  });

  it("returns null for .yaml files", () => {
    expect(detectLanguage("config.yaml")).toBeNull();
  });

  it("returns null for files with no extension", () => {
    expect(detectLanguage("Makefile")).toBeNull();
  });

  it("is case-insensitive for extensions", () => {
    expect(detectLanguage("Main.TS")).toBe("typescript");
    expect(detectLanguage("Main.RS")).toBe("rust");
  });

  it("handles absolute paths correctly", () => {
    expect(detectLanguage("/Users/dev/project/src/main.ts")).toBe("typescript");
  });

  it("handles paths with multiple dots", () => {
    expect(detectLanguage("src/my.component.test.ts")).toBe("typescript");
  });
});
