import { describe, expect, it } from "bun:test";

import type { AIAction, AIMode, AIRequestEvent } from "@ai-coding/shared";

import { selectModel } from "./select-model";

/** Helper to build a minimal AIRequestEvent with a given action. */
function makeEvent(action: AIAction): AIRequestEvent {
  return {
    id: "test-1",
    timestamp: Date.now(),
    source: "cli",
    action,
    payload: {},
  };
}

describe("selectModel", () => {
  describe("agentic mode", () => {
    const mode: AIMode = "agentic";

    it("returns claude-sonnet for plan action", () => {
      expect(selectModel(makeEvent("plan"), mode)).toBe("claude-sonnet-4.6");
    });

    it("returns deepseek-coder-v2 for debug action", () => {
      expect(selectModel(makeEvent("debug"), mode)).toBe("deepseek-coder-v2");
    });

    it.each(["explain", "edit", "refactor", "chat", "task", "explore"] satisfies AIAction[])(
      "returns qwen3:8b for %s action",
      (action) => {
        expect(selectModel(makeEvent(action), mode)).toBe("qwen3:8b");
      },
    );
  });

  describe("editor mode", () => {
    const mode: AIMode = "editor";

    it.each([
      "plan",
      "debug",
      "explain",
      "edit",
      "refactor",
      "chat",
      "task",
      "explore",
    ] satisfies AIAction[])("returns qwen3:8b for %s action regardless of action", (action) => {
      expect(selectModel(makeEvent(action), mode)).toBe("qwen3:8b");
    });
  });
});
