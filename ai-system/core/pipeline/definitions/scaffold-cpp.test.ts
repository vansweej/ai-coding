import { describe, expect, it } from "bun:test";

import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createCppScaffoldPipeline } from "./scaffold-cpp";

/** Minimal OrchestratorConfig stub -- steps are not executed in these tests. */
const STUB_CONFIG: OrchestratorConfig = { dispatchers: {} };

describe("createCppScaffoldPipeline", () => {
  it("returns exactly 4 steps", () => {
    const steps = createCppScaffoldPipeline(STUB_CONFIG, "/tmp/test-cpp");
    expect(steps).toHaveLength(4);
  });

  it("has step names in order: generate, write-files, configure, write-agents-md", () => {
    const steps = createCppScaffoldPipeline(STUB_CONFIG, "/tmp/test-cpp");
    expect(steps.map((s) => s.name)).toEqual([
      "generate",
      "write-files",
      "configure",
      "write-agents-md",
    ]);
  });

  it("uses the default build directory when none is specified", () => {
    const steps = createCppScaffoldPipeline(STUB_CONFIG, "/tmp/test-cpp");
    expect(steps).toHaveLength(4);
  });

  it("produces a different pipeline instance on each call", () => {
    const a = createCppScaffoldPipeline(STUB_CONFIG, "/tmp/a");
    const b = createCppScaffoldPipeline(STUB_CONFIG, "/tmp/b");
    expect(a).not.toBe(b);
  });

  it("generate step routes to claude-sonnet (plan action)", async () => {
    let capturedModel = "";
    const capturingDispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        capturedModel = req.model;
        // Return minimal valid code blocks so the step succeeds.
        return {
          ok: true,
          value:
            "```cmake CMakeLists.txt\ncmake_minimum_required(VERSION 3.20)\n```\n" +
            "```cpp src/main.cpp\nint main(){}\n```\n" +
            "```nix flake.nix\n{ outputs = {}; }\n```",
        };
      },
    };

    const config: OrchestratorConfig = {
      dispatchers: { "claude-sonnet-4.6": capturingDispatcher },
    };

    const steps = createCppScaffoldPipeline(config, "/tmp/test-cpp");
    const event: AIRequestEvent = {
      id: "t",
      timestamp: Date.now(),
      source: "cli",
      action: "task",
      payload: {},
    };

    await steps[0].execute({ event, results: new Map() });

    expect(capturedModel).toBe("claude-sonnet-4.6");
  });
});
