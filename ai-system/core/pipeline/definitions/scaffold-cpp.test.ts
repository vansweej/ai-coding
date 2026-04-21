import { describe, expect, it } from "bun:test";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createCppScaffoldPipeline } from "./scaffold-cpp";

/** Minimal OrchestratorConfig stub -- steps are not executed in these tests. */
const STUB_CONFIG: OrchestratorConfig = { dispatchers: {} };

describe("createCppScaffoldPipeline", () => {
  it("returns exactly 3 steps", () => {
    const steps = createCppScaffoldPipeline(STUB_CONFIG, "/tmp/test-cpp");
    expect(steps).toHaveLength(3);
  });

  it("has step names in order: generate, write-files, configure", () => {
    const steps = createCppScaffoldPipeline(STUB_CONFIG, "/tmp/test-cpp");
    expect(steps.map((s) => s.name)).toEqual(["generate", "write-files", "configure"]);
  });

  it("uses the default build directory when none is specified", () => {
    const steps = createCppScaffoldPipeline(STUB_CONFIG, "/tmp/test-cpp");
    expect(steps).toHaveLength(3);
  });

  it("produces a different pipeline instance on each call", () => {
    const a = createCppScaffoldPipeline(STUB_CONFIG, "/tmp/a");
    const b = createCppScaffoldPipeline(STUB_CONFIG, "/tmp/b");
    expect(a).not.toBe(b);
  });
});
