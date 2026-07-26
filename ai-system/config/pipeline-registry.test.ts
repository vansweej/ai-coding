import { describe, expect, it } from "bun:test";

import { PIPELINE_NAMES, PIPELINE_REGISTRY, findPipelineEntry } from "./pipeline-registry";

describe("PIPELINE_REGISTRY", () => {
  it("contains 4 entries", () => {
    expect(PIPELINE_REGISTRY).toHaveLength(4);
  });

  it("includes plan-cycle", () => {
    expect(PIPELINE_REGISTRY.some((e) => e.name === "plan-cycle")).toBe(true);
  });

  it("includes doc-cycle", () => {
    expect(PIPELINE_REGISTRY.some((e) => e.name === "doc-cycle")).toBe(true);
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
  it("returns the plan-cycle entry", () => {
    const entry = findPipelineEntry("plan-cycle");
    expect(entry?.name).toBe("plan-cycle");
  });

  it("returns undefined for unknown pipeline", () => {
    expect(findPipelineEntry("does-not-exist")).toBeUndefined();
  });
});
