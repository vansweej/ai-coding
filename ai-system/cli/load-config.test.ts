import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { loadConfig } from "./load-config";

describe("loadConfig", () => {
  const ORIG_OLLAMA_URL = process.env.OLLAMA_URL;
  const ORIG_COPILOT_TOKEN = process.env.GITHUB_COPILOT_TOKEN;
  const ORIG_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    // Clear Copilot token and Anthropic API key before each test
    const env = process.env as Record<string, string | undefined>;
    delete env.GITHUB_COPILOT_TOKEN;
    delete env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    const env = process.env as Record<string, string | undefined>;
    env.OLLAMA_URL = ORIG_OLLAMA_URL;
    env.GITHUB_COPILOT_TOKEN = ORIG_COPILOT_TOKEN;
    env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC_API_KEY;
  });

  it("returns a config with local profile and gemma4:26b dispatcher", async () => {
    const result = await loadConfig("local");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("local");
      expect(result.value.dispatchers["gemma4:26b"]).toBeDefined();
    }
  });

  it("returns error for an unknown profile", async () => {
    const result = await loadConfig("unknown-profile");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Unknown profile");
  });

  it("returns error when Ollama is not reachable for local profile", async () => {
    const result = await loadConfig("local", "http://192.0.2.1:11434");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not reachable");
  });

  it("returns error for copilot-default profile when GITHUB_COPILOT_TOKEN is not set", async () => {
    const result = await loadConfig("copilot-default");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("GITHUB_COPILOT_TOKEN");
  });

  it("returns a config with copilot-default profile when GITHUB_COPILOT_TOKEN is set", async () => {
    const env = process.env as Record<string, string>;
    env.GITHUB_COPILOT_TOKEN = "test-token";
    const result = await loadConfig("copilot-default");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("copilot-default");
      expect(result.value.dispatchers["claude-sonnet-4.6"]).toBeDefined();
    }
  });

  it("returns error for hybrid profile when GITHUB_COPILOT_TOKEN is not set", async () => {
    const result = await loadConfig("hybrid");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("GITHUB_COPILOT_TOKEN");
  });

  it("returns a config with hybrid profile when GITHUB_COPILOT_TOKEN is set", async () => {
    const env = process.env as Record<string, string>;
    env.GITHUB_COPILOT_TOKEN = "test-token";
    const result = await loadConfig("hybrid");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("hybrid");
      expect(result.value.dispatchers["gemma4:26b"]).toBeDefined();
      expect(result.value.dispatchers["claude-sonnet-4.6"]).toBeDefined();
    }
  });

  it("uses copilot-default as default profile when none specified", async () => {
    const env = process.env as Record<string, string>;
    env.GITHUB_COPILOT_TOKEN = "test-token";
    const result = await loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("copilot-default");
    }
  });

  it("returns error for anthropic-sonnet profile when ANTHROPIC_API_KEY is not set", async () => {
    const result = await loadConfig("anthropic-sonnet");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("ANTHROPIC_API_KEY");
  });

  it("returns a config with anthropic-sonnet profile when ANTHROPIC_API_KEY is set", async () => {
    const env = process.env as Record<string, string>;
    env.ANTHROPIC_API_KEY = "test-api-key";
    const result = await loadConfig("anthropic-sonnet");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("anthropic-sonnet");
      expect(result.value.dispatchers["claude-sonnet-5"]).toBeDefined();
    }
  });
});
