import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { loadConfig } from "./load-config";

describe("loadConfig", () => {
  const ORIG_OLLAMA_URL = process.env.OLLAMA_URL;
  const ORIG_COPILOT_TOKEN = process.env.GITHUB_COPILOT_TOKEN;
  const ORIG_ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const ORIG_BEDROCK_ARN = process.env.AWS_BEDROCK_INFERENCE_PROFILE_ARN;
  const ORIG_ZEN_API_KEY = process.env.OPENCODE_ZEN_API_KEY;
  const ORIG_ZEN_MODEL = process.env.OPENCODE_ZEN_MODEL;

  beforeEach(() => {
    // Clear Copilot token and Anthropic API key before each test
    const env = process.env as Record<string, string | undefined>;
    env.GITHUB_COPILOT_TOKEN = undefined;
    env.ANTHROPIC_API_KEY = undefined;
    env.AWS_BEDROCK_INFERENCE_PROFILE_ARN = undefined;
    env.OPENCODE_ZEN_API_KEY = undefined;
    env.OPENCODE_ZEN_MODEL = undefined;
  });

  afterEach(() => {
    const env = process.env as Record<string, string | undefined>;
    env.OLLAMA_URL = ORIG_OLLAMA_URL;
    env.GITHUB_COPILOT_TOKEN = ORIG_COPILOT_TOKEN;
    env.ANTHROPIC_API_KEY = ORIG_ANTHROPIC_API_KEY;
    env.AWS_BEDROCK_INFERENCE_PROFILE_ARN = ORIG_BEDROCK_ARN;
    env.OPENCODE_ZEN_API_KEY = ORIG_ZEN_API_KEY;
    env.OPENCODE_ZEN_MODEL = ORIG_ZEN_MODEL;
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
      expect(result.value.dispatchers["copilot/claude-sonnet-5"]).toBeDefined();
    }
  });

  it("binds the copilot/claude-sonnet-5 dispatcher to the same Copilot dispatcher as claude-sonnet-4.6", async () => {
    const env = process.env as Record<string, string>;
    env.GITHUB_COPILOT_TOKEN = "test-token";
    const result = await loadConfig("copilot-default");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const copilotBound = result.value.dispatchers["copilot/claude-sonnet-5"];
      expect(copilotBound).toBeDefined();
      expect(copilotBound?.constructor.name).toBe("CopilotDispatcher");
    }
  });

  it("requires GITHUB_COPILOT_TOKEN (not ANTHROPIC_API_KEY) for copilot-default", async () => {
    const env = process.env as Record<string, string>;
    Reflect.deleteProperty(env, "GITHUB_COPILOT_TOKEN");
    const result = await loadConfig("copilot-default");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("GITHUB_COPILOT_TOKEN");
      expect(result.error.message).not.toContain("ANTHROPIC_API_KEY");
      expect(result.error.message).not.toContain("Ollama");
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

  it("returns error for bedrock-sonnet profile when AWS_BEDROCK_INFERENCE_PROFILE_ARN is not set", async () => {
    const result = await loadConfig("bedrock-sonnet");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("AWS_BEDROCK_INFERENCE_PROFILE_ARN");
  });

  it("returns a config with bedrock-sonnet profile when AWS_BEDROCK_INFERENCE_PROFILE_ARN is set", async () => {
    const env = process.env as Record<string, string>;
    env.AWS_BEDROCK_INFERENCE_PROFILE_ARN =
      "arn:aws:bedrock:eu-west-1:953734003896:application-inference-profile/mekgfwxmx7tr";
    const result = await loadConfig("bedrock-sonnet");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("bedrock-sonnet");
      expect(result.value.dispatchers["bedrock-sonnet"]).toBeDefined();
    }
  });

  it("returns error for opencode-free profile when OPENCODE_ZEN_MODEL is not set", async () => {
    const result = await loadConfig("opencode-free");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("OPENCODE_ZEN_MODEL");
  });

  it("returns a config with opencode-free profile when OPENCODE_ZEN_MODEL is set and no API key is set (free-tier models require no auth)", async () => {
    const env = process.env as Record<string, string>;
    env.OPENCODE_ZEN_MODEL = "deepseek-v4-flash-free";
    const result = await loadConfig("opencode-free");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("opencode-free");
      expect(result.value.dispatchers["opencode-free"]).toBeDefined();
    }
  });

  it("returns a config with opencode-free profile when both Zen env vars are set", async () => {
    const env = process.env as Record<string, string>;
    env.OPENCODE_ZEN_API_KEY = "test-zen-key";
    env.OPENCODE_ZEN_MODEL = "deepseek-v4-flash-free";
    const result = await loadConfig("opencode-free");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("opencode-free");
      expect(result.value.dispatchers["opencode-free"]).toBeDefined();
    }
  });
});
