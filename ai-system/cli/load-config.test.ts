import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, resolveCopilotToken } from "./load-config";

describe("resolveCopilotToken", () => {
  const ORIG_COPILOT_TOKEN = process.env.COPILOT_TOKEN;
  const ORIG_GITHUB_COPILOT_TOKEN = process.env.GITHUB_COPILOT_TOKEN;

  beforeEach(() => {
    const env = process.env as Record<string, string | undefined>;
    env.COPILOT_TOKEN = undefined;
    env.GITHUB_COPILOT_TOKEN = undefined;
  });

  afterEach(() => {
    const env = process.env as Record<string, string | undefined>;
    env.COPILOT_TOKEN = ORIG_COPILOT_TOKEN;
    env.GITHUB_COPILOT_TOKEN = ORIG_GITHUB_COPILOT_TOKEN;
  });

  it("resolves COPILOT_TOKEN env var first", () => {
    process.env.COPILOT_TOKEN = "gho_from_env";
    const result = resolveCopilotToken("/nonexistent/auth.json");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("gho_from_env");
  });

  it("resolves GITHUB_COPILOT_TOKEN env var when COPILOT_TOKEN is absent", () => {
    process.env.GITHUB_COPILOT_TOKEN = "gho_github_env";
    const result = resolveCopilotToken("/nonexistent/auth.json");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("gho_github_env");
  });

  it("COPILOT_TOKEN takes precedence over GITHUB_COPILOT_TOKEN", () => {
    process.env.COPILOT_TOKEN = "gho_primary";
    process.env.GITHUB_COPILOT_TOKEN = "gho_secondary";
    const result = resolveCopilotToken("/nonexistent/auth.json");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("gho_primary");
  });

  it("reads token from OpenCode auth.json when env vars are absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-coding-test-"));
    try {
      const authPath = join(dir, "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({ "github-copilot": { access: "gho_from_opencode" } }),
      );
      const result = resolveCopilotToken(authPath);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe("gho_from_opencode");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns error when OpenCode auth.json has no github-copilot key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-coding-test-"));
    try {
      const authPath = join(dir, "auth.json");
      writeFileSync(authPath, JSON.stringify({}));
      const result = resolveCopilotToken(authPath);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("No Copilot token found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns error when OpenCode auth.json is malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-coding-test-"));
    try {
      const authPath = join(dir, "auth.json");
      writeFileSync(authPath, "not-json{{{");
      const result = resolveCopilotToken(authPath);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("Failed to parse OpenCode auth file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns error when no token source is available", () => {
    const result = resolveCopilotToken("/nonexistent/auth.json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("No Copilot token found");
  });
});

describe("loadConfig", () => {
  const ORIG_COPILOT_TOKEN = process.env.COPILOT_TOKEN;

  afterEach(() => {
    const env = process.env as Record<string, string | undefined>;
    env.COPILOT_TOKEN = ORIG_COPILOT_TOKEN;
  });

  it("returns a config with copilot-default profile and claude-sonnet-4.6 dispatcher", () => {
    process.env.COPILOT_TOKEN = "gho_test_token";
    const result = loadConfig("/nonexistent/auth.json");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("copilot-default");
      expect(result.value.dispatchers["claude-sonnet-4.6"]).toBeDefined();
      expect(result.value.dispatchers["qwen3:8b"]).toBeUndefined();
      expect(result.value.dispatchers["deepseek-coder-v2"]).toBeUndefined();
    }
  });

  it("returns error when no token source is available", () => {
    const env = process.env as Record<string, string | undefined>;
    env.COPILOT_TOKEN = undefined;
    env.GITHUB_COPILOT_TOKEN = undefined;
    const result = loadConfig("/nonexistent/auth.json");
    expect(result.ok).toBe(false);
  });
});
