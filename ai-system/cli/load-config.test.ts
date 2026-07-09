import { afterEach, describe, expect, it } from "bun:test";

import { loadConfig } from "./load-config";

describe("loadConfig", () => {
  const ORIG_OLLAMA_URL = process.env.OLLAMA_URL;

  afterEach(() => {
    const env = process.env as Record<string, string | undefined>;
    env.OLLAMA_URL = ORIG_OLLAMA_URL;
  });

  it("returns a config with local profile and gemma4:26b dispatcher", async () => {
    const result = await loadConfig("local");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("local");
      expect(result.value.dispatchers["gemma4:26b"]).toBeDefined();
    }
  });

  it("returns a config using the default profile when none specified", async () => {
    const result = await loadConfig();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.profile?.name).toBe("local");
    }
  });

  it("returns error for an unknown profile", async () => {
    const result = await loadConfig("unknown-profile");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Unknown profile");
  });

  it("returns error when Ollama is not reachable", async () => {
    const result = await loadConfig("local", "http://192.0.2.1:11434");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("not reachable");
  });
});
