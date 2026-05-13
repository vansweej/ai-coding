import { describe, expect, it } from "bun:test";

import { DOC_CYCLE_SKETCH, createDocCyclePipeline } from "./doc-cycle";

describe("DOC_CYCLE_SKETCH", () => {
  it("documents the deferred doc-cycle shape", () => {
    expect(DOC_CYCLE_SKETCH.steps).toEqual(["read-source", "generate-docs", "write-docs"]);
    expect(DOC_CYCLE_SKETCH.input).toBe("documentation phase from a structured plan file");
    expect(DOC_CYCLE_SKETCH.output).toBe("markdown files under docs/");
    expect(DOC_CYCLE_SKETCH.modelRole).toBe("documenter");
  });

  it("does not create executable steps while deferred", () => {
    expect(createDocCyclePipeline()).toEqual([]);
  });
});
