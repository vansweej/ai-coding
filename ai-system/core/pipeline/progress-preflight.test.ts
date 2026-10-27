import { describe, expect, it } from "bun:test";

import { buildTheme, formatProgressEvent } from "./progress";

describe("formatProgressEvent: preflight kind", () => {
  it("formats a preflight event with the ASCII theme glyph and counts", () => {
    const theme = buildTheme(false);
    const line = formatProgressEvent(
      { kind: "preflight", errors: 1, warnings: 2, violations: ["a", "b", "c"] },
      theme,
    );
    expect(line).toBe("# Preflight  1 error(s), 2 warning(s)");
  });

  it("formats a preflight event with the nerd-font color theme", () => {
    const theme = buildTheme(true);
    const line = formatProgressEvent(
      { kind: "preflight", errors: 0, warnings: 0, violations: [] },
      theme,
    );
    expect(line).toContain("Preflight  0 error(s), 0 warning(s)");
    expect(line).toContain("⚑");
  });
});
