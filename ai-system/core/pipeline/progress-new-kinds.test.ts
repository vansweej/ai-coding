import { describe, expect, it } from "bun:test";

import { buildTheme, formatProgressEvent } from "./progress";

/**
 * Exercises the new `snapshot` and `attempt-result` `ProgressEvent` kinds
 * added for forensic snapshots: proves `formatProgressEvent`'s exhaustive
 * switch covers every variant of both new kinds under both themes.
 */
describe("formatProgressEvent: snapshot and attempt-result kinds", () => {
  it("formats a snapshot event with a dir under the nerd-font theme", () => {
    const theme = buildTheme(true);
    const line = formatProgressEvent(
      {
        kind: "snapshot",
        phase: 1,
        label: "verification-failed",
        dir: "/tmp/ai-coding/ledger/snapshots/run-1/phase-1-verification-failed",
        treeSha: "abc123",
      },
      theme,
    );

    expect(line.length).toBeGreaterThan(0);
  });

  it("formats a snapshot event with only a reason under the ASCII theme", () => {
    const theme = buildTheme(false);
    const line = formatProgressEvent(
      { kind: "snapshot", phase: 2, label: "no-net-change", reason: "not a git repository" },
      theme,
    );

    expect(line.length).toBeGreaterThan(0);
  });

  it("formats a snapshot event with only a reason under the nerd-font theme", () => {
    const theme = buildTheme(true);
    const line = formatProgressEvent(
      { kind: "snapshot", phase: 2, label: "assertion-failed", reason: "git unavailable" },
      theme,
    );

    expect(line.length).toBeGreaterThan(0);
  });

  it("formats a snapshot event with a dir under the ASCII theme", () => {
    const theme = buildTheme(false);
    const line = formatProgressEvent(
      {
        kind: "snapshot",
        phase: 3,
        label: "resume-reset",
        dir: "/tmp/ai-coding/ledger/snapshots/run-2/phase-3-resume-reset",
        treeSha: "def456",
      },
      theme,
    );

    expect(line.length).toBeGreaterThan(0);
  });

  it("formats a successful attempt-result event under the nerd-font theme", () => {
    const theme = buildTheme(true);
    const line = formatProgressEvent(
      { kind: "attempt-result", phase: 1, attempt: 0, retry: "structured", ok: true },
      theme,
    );

    expect(line.length).toBeGreaterThan(0);
  });

  it("formats a failed attempt-result event with an error under the ASCII theme", () => {
    const theme = buildTheme(false);
    const line = formatProgressEvent(
      {
        kind: "attempt-result",
        phase: 1,
        attempt: 1,
        retry: "local",
        ok: false,
        error: "typecheck failed",
      },
      theme,
    );

    expect(line.length).toBeGreaterThan(0);
  });

  it("formats a successful escalation attempt-result event under the ASCII theme", () => {
    const theme = buildTheme(false);
    const line = formatProgressEvent(
      { kind: "attempt-result", phase: 2, attempt: 2, retry: "escalation", ok: true },
      theme,
    );

    expect(line.length).toBeGreaterThan(0);
  });

  it("formats a failed escalation attempt-result event with an error under the nerd-font theme", () => {
    const theme = buildTheme(true);
    const line = formatProgressEvent(
      {
        kind: "attempt-result",
        phase: 2,
        attempt: 3,
        retry: "escalation",
        ok: false,
        error: "lint failed",
      },
      theme,
    );

    expect(line.length).toBeGreaterThan(0);
  });
});
