import { describe, expect, it } from "bun:test";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createRustScaffoldPipeline } from "./scaffold-rust";

/** Minimal OrchestratorConfig stub -- steps are not executed in these tests. */
const STUB_CONFIG: OrchestratorConfig = { dispatchers: {} };

describe("createRustScaffoldPipeline", () => {
  it("returns exactly 3 steps", () => {
    const steps = createRustScaffoldPipeline(STUB_CONFIG, "/tmp/test-rust");
    expect(steps).toHaveLength(3);
  });

  it("has step names in order: init, generate-flake, write-files", () => {
    const steps = createRustScaffoldPipeline(STUB_CONFIG, "/tmp/test-rust");
    expect(steps.map((s) => s.name)).toEqual(["init", "generate-flake", "write-files"]);
  });

  it("produces a different pipeline instance on each call", () => {
    const a = createRustScaffoldPipeline(STUB_CONFIG, "/tmp/a");
    const b = createRustScaffoldPipeline(STUB_CONFIG, "/tmp/b");
    expect(a).not.toBe(b);
  });
});
