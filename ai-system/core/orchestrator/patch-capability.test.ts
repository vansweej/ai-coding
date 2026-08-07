import { describe, expect, it } from "bun:test";

import { patchModeForModel } from "./patch-capability";

describe("patchModeForModel", () => {
  it("returns anthropic-tool-use for claude-sonnet-5", () => {
    expect(patchModeForModel("claude-sonnet-5")).toBe("anthropic-tool-use");
  });

  it("returns text for an unknown model-ID", () => {
    expect(patchModeForModel("some-unregistered-model")).toBe("text");
  });

  it("returns text for the local gemma model (opts in only in a later plan)", () => {
    expect(patchModeForModel("gemma4:26b")).toBe("text");
  });

  it("returns openai-tool-calls for the Copilot-served Sonnet model", () => {
    expect(patchModeForModel("copilot/claude-sonnet-5")).toBe("openai-tool-calls");
  });

  it("returns openai-tool-calls for claude-sonnet-4.6 (Copilot-served, not the Anthropic-native id)", () => {
    expect(patchModeForModel("claude-sonnet-4.6")).toBe("openai-tool-calls");
  });

  it("returns text for the opencode-free logical token", () => {
    expect(patchModeForModel("opencode-free")).toBe("text");
  });

  it("returns text for the bedrock-sonnet logical token", () => {
    expect(patchModeForModel("bedrock-sonnet")).toBe("text");
  });
});
