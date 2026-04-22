import { describe, expect, it } from "bun:test";

import { PIPELINE_NAMES, PIPELINE_REGISTRY, findPipelineEntry } from "./pipeline-registry";

describe("PIPELINE_REGISTRY", () => {
  it("contains 5 entries", () => {
    expect(PIPELINE_REGISTRY).toHaveLength(5);
  });

  it("includes dev-cycle", () => {
    expect(PIPELINE_REGISTRY.some((e) => e.name === "dev-cycle")).toBe(true);
  });

  it("includes rust-dev-cycle", () => {
    expect(PIPELINE_REGISTRY.some((e) => e.name === "rust-dev-cycle")).toBe(true);
  });

  it("includes cmake-dev-cycle", () => {
    expect(PIPELINE_REGISTRY.some((e) => e.name === "cmake-dev-cycle")).toBe(true);
  });

  it("includes scaffold-rust", () => {
    expect(PIPELINE_REGISTRY.some((e) => e.name === "scaffold-rust")).toBe(true);
  });

  it("includes scaffold-cpp", () => {
    expect(PIPELINE_REGISTRY.some((e) => e.name === "scaffold-cpp")).toBe(true);
  });

  it("every entry has a non-empty description", () => {
    for (const entry of PIPELINE_REGISTRY) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("every entry has a non-empty stack", () => {
    for (const entry of PIPELINE_REGISTRY) {
      expect(entry.stack.length).toBeGreaterThan(0);
    }
  });
});

describe("PIPELINE_NAMES", () => {
  it("contains all registry names", () => {
    for (const entry of PIPELINE_REGISTRY) {
      expect(PIPELINE_NAMES.has(entry.name)).toBe(true);
    }
  });

  it("has size equal to registry length", () => {
    expect(PIPELINE_NAMES.size).toBe(PIPELINE_REGISTRY.length);
  });
});

describe("findPipelineEntry", () => {
  it("returns the dev-cycle entry", () => {
    const entry = findPipelineEntry("dev-cycle");
    expect(entry?.name).toBe("dev-cycle");
  });

  it("returns the rust-dev-cycle entry", () => {
    const entry = findPipelineEntry("rust-dev-cycle");
    expect(entry?.name).toBe("rust-dev-cycle");
  });

  it("returns undefined for unknown pipeline", () => {
    expect(findPipelineEntry("does-not-exist")).toBeUndefined();
  });
});
