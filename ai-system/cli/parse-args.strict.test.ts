import { describe, expect, it } from "bun:test";
import { loadConfig } from "./load-config";

describe("parse-args strict", () => {
  it("loadConfig accepts strict: true and returns a config with strict enabled", async () => {
    const env = process.env as Record<string, string>;
    const origToken = process.env.GITHUB_COPILOT_TOKEN;
    env.GITHUB_COPILOT_TOKEN = "test-token";
    try {
      const result = await loadConfig("copilot-default", undefined, true);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.strict).toBe(true);
      }
    } finally {
      if (origToken === undefined) {
        delete (process.env as Record<string, string | undefined>).GITHUB_COPILOT_TOKEN;
      } else {
        env.GITHUB_COPILOT_TOKEN = origToken;
      }
    }
  });
});