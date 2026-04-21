import { describe, expect, it } from "bun:test";

import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { createRustScaffoldPipeline } from "./scaffold-rust";

/** Minimal OrchestratorConfig stub -- steps are not executed in these tests. */
const STUB_CONFIG: OrchestratorConfig = { dispatchers: {} };

describe("createRustScaffoldPipeline", () => {
  it("returns exactly 4 steps", () => {
    const steps = createRustScaffoldPipeline(STUB_CONFIG, "/tmp/test-rust");
    expect(steps).toHaveLength(4);
  });

  it("has step names in order: generate-flake, write-files, git-init, init", () => {
    const steps = createRustScaffoldPipeline(STUB_CONFIG, "/tmp/test-rust");
    expect(steps.map((s) => s.name)).toEqual(["generate-flake", "write-files", "git-init", "init"]);
  });

  it("produces a different pipeline instance on each call", () => {
    const a = createRustScaffoldPipeline(STUB_CONFIG, "/tmp/a");
    const b = createRustScaffoldPipeline(STUB_CONFIG, "/tmp/b");
    expect(a).not.toBe(b);
  });

  it("generate-flake step routes to claude-sonnet (plan action)", async () => {
    let capturedModel = "";
    const capturingDispatcher: ModelDispatcher = {
      dispatch: async (req: DispatchRequest): Promise<Result<string>> => {
        capturedModel = req.model;
        // Return a minimal valid flake.nix code block so the step succeeds.
        return {
          ok: true,
          value: "```nix flake.nix\n{ outputs = {}; }\n```",
        };
      },
    };

    const config: OrchestratorConfig = {
      dispatchers: { "claude-sonnet": capturingDispatcher },
    };

    const steps = createRustScaffoldPipeline(config, "/tmp/test-rust");
    const event: AIRequestEvent = {
      id: "t",
      timestamp: Date.now(),
      source: "cli",
      action: "task",
      payload: {},
    };

    await steps[0].execute({ event, results: new Map() });

    expect(capturedModel).toBe("claude-sonnet");
  });
});
