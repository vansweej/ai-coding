import { describe, expect, it } from "bun:test";

import type { AISource } from "@ai-coding/shared";

import { resolveMode } from "./resolve-mode";

describe("resolveMode", () => {
  it("returns editor for nvim source", () => {
    expect(resolveMode("nvim")).toBe("editor");
  });

  it.each(["cli", "agent", "api"] satisfies AISource[])(
    "returns agentic for %s source",
    (source) => {
      expect(resolveMode(source)).toBe("agentic");
    },
  );
});
