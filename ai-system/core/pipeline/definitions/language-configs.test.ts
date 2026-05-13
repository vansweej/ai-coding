import { describe, expect, it } from "bun:test";

import {
  CPP_CONFIG,
  DEV_CYCLE_LANGUAGE_CONFIGS,
  RUST_CONFIG,
  TYPESCRIPT_CONFIG,
} from "./language-configs";

describe("language configs", () => {
  it("registers TypeScript, Rust, and C++ configs", () => {
    expect(DEV_CYCLE_LANGUAGE_CONFIGS.typescript).toBe(TYPESCRIPT_CONFIG);
    expect(DEV_CYCLE_LANGUAGE_CONFIGS.rust).toBe(RUST_CONFIG);
    expect(DEV_CYCLE_LANGUAGE_CONFIGS.cpp).toBe(CPP_CONFIG);
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
});
