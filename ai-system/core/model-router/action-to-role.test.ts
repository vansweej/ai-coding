import { describe, expect, it } from "bun:test";

import type { AIAction } from "@ai-coding/shared";

import { actionToRole } from "./action-to-role";

describe("actionToRole", () => {
  it("maps plan to planner", () => {
    expect(actionToRole("plan")).toBe("planner");
  });

  it("maps debug to debugger", () => {
    expect(actionToRole("debug")).toBe("debugger");
  });

  it("maps edit to implementer", () => {
    expect(actionToRole("edit")).toBe("implementer");
  });

  it("maps refactor to implementer", () => {
    expect(actionToRole("refactor")).toBe("implementer");
  });

  it("maps task to implementer", () => {
    expect(actionToRole("task")).toBe("implementer");
  });

  it("maps explain to default", () => {
    expect(actionToRole("explain")).toBe("default");
  });

  it("maps chat to default", () => {
    expect(actionToRole("chat")).toBe("default");
  });

  it("covers all AIAction values", () => {
    const allActions: AIAction[] = ["plan", "debug", "edit", "refactor", "task", "explain", "chat"];
    for (const action of allActions) {
      expect(actionToRole(action)).toBeDefined();
    }
  });
});
