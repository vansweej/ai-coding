import { describe, expect, it } from "bun:test";

import type { ProgressEvent } from "./progress";
import { buildTheme, formatProgressEvent } from "./progress";

const EVENTS: readonly ProgressEvent[] = [
  { kind: "phase-start", phase: 1, title: "Wire the parser" },
  { kind: "phase-attempt", phase: 1, retry: "local", index: 2, max: 3 },
  { kind: "phase-finish", phase: 1, commitMessage: "feat: wire the parser" },
  { kind: "phase-fail", phase: 1, reason: "verification failed" },
  { kind: "step-start", phase: 1, step: 2, title: "Parse expressions" },
  { kind: "step-finish", phase: 1, step: 2 },
  { kind: "step-fail", phase: 1, step: 2, reason: "patch anchor not found" },
  { kind: "step-retry", phase: 1, step: 2, index: 1, max: 3, retry: "local" },
];

describe("buildTheme", () => {
  it("returns a color theme with nerd-font glyphs when useColor is true", () => {
    const theme = buildTheme(true);
    expect(theme.useColor).toBe(true);
    expect(theme.glyphs["phase-start"]).toBe("▶");
    expect(theme.glyphs["step-fail"]).toBe("✗");
  });

  it("returns a plain ASCII theme when useColor is false", () => {
    const theme = buildTheme(false);
    expect(theme.useColor).toBe(false);
    expect(theme.glyphs["phase-start"]).toBe(">");
    expect(theme.glyphs["step-fail"]).toBe("x");
  });

  it("produces different glyph maps for color vs plain themes", () => {
    const color = buildTheme(true);
    const plain = buildTheme(false);
    expect(color.glyphs).not.toEqual(plain.glyphs);
  });
});

describe("formatProgressEvent (plain theme)", () => {
  const theme = buildTheme(false);

  it("formats phase-start without indentation", () => {
    expect(formatProgressEvent(EVENTS[0], theme)).toBe("> Phase 1  Wire the parser");
  });

  it("formats phase-attempt", () => {
    expect(formatProgressEvent(EVENTS[1], theme)).toBe(
      "~ Phase 1  re-implementing & verifying · local 2/3",
    );
  });

  it("formats phase-finish", () => {
    expect(formatProgressEvent(EVENTS[2], theme)).toBe(
      "+ Phase 1  committed: feat: wire the parser",
    );
  });

  it("formats phase-fail", () => {
    expect(formatProgressEvent(EVENTS[3], theme)).toBe("X Phase 1  aborted: verification failed");
  });

  it("formats step-start with two-space indentation", () => {
    expect(formatProgressEvent(EVENTS[4], theme)).toBe("  o Step 2  Parse expressions");
  });

  it("formats step-finish with two-space indentation", () => {
    expect(formatProgressEvent(EVENTS[5], theme)).toBe("  + Step 2");
  });

  it("formats step-fail with two-space indentation", () => {
    expect(formatProgressEvent(EVENTS[6], theme)).toBe(
      "  x Step 2  failed: patch anchor not found",
    );
  });

  it("formats step-retry with two-space indentation", () => {
    expect(formatProgressEvent(EVENTS[7], theme)).toBe("  ~ Step 2  local retry 1/3");
  });

  it("never emits ANSI escape codes under the plain theme", () => {
    for (const event of EVENTS) {
      expect(formatProgressEvent(event, theme)).not.toContain("\x1b[");
    }
  });
});

describe("formatProgressEvent (color theme)", () => {
  const theme = buildTheme(true);

  it("wraps each glyph in its SGR color code and resets after", () => {
    for (const event of EVENTS) {
      const line = formatProgressEvent(event, theme);
      expect(line).toContain("\x1b[");
      expect(line).toContain("\x1b[0m");
    }
  });

  it("formats phase-start with the cyan glyph and full label", () => {
    const line = formatProgressEvent(EVENTS[0], theme);
    expect(line).toBe("\x1b[36m▶\x1b[0m Phase 1  Wire the parser");
  });

  it("formats step-fail with the red glyph, indented", () => {
    const line = formatProgressEvent(EVENTS[6], theme);
    expect(line).toBe("  \x1b[31m✗\x1b[0m Step 2  failed: patch anchor not found");
  });
});
