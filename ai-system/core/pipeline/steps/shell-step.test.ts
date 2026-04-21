import { describe, expect, it } from "bun:test";

import type { AIRequestEvent } from "@ai-coding/shared";

import type { PipelineContext } from "../pipeline-types";
import { createShellStep } from "./shell-step";

/** Builds a minimal PipelineContext for shell step tests (context is not used by ShellStep). */
function makeCtx(): PipelineContext {
  const event: AIRequestEvent = {
    id: "test-1",
    timestamp: Date.now(),
    source: "cli",
    action: "edit",
    payload: {},
  };
  return { event, results: new Map() };
}

describe("createShellStep", () => {
  it("captures stdout from a successful command", async () => {
    const step = createShellStep("echo-step", ["echo", "hello"]);
    const result = await step.execute(makeCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output.trim()).toBe("hello");
  });

  it("returns error on non-zero exit code by default", async () => {
    // `false` is a POSIX command that always exits with code 1
    const step = createShellStep("fail-step", ["false"]);
    const result = await step.execute(makeCtx());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("exited with code 1");
    expect(result.error.message).toContain("fail-step");
  });

  it("includes stderr in the error message on failure", async () => {
    const step = createShellStep("err-step", ["sh", "-c", "echo my-error >&2; exit 1"]);
    const result = await step.execute(makeCtx());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("my-error");
  });

  it("succeeds with non-zero exit when failOnNonZero is false", async () => {
    const step = createShellStep("lenient-step", ["sh", "-c", "echo output; exit 1"], {
      failOnNonZero: false,
    });
    const result = await step.execute(makeCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output.trim()).toBe("output");
  });

  it("returns error when command times out", async () => {
    const step = createShellStep("slow-step", ["sleep", "10"], { timeoutMs: 50 });
    const result = await step.execute(makeCtx());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("timed out");
    expect(result.error.message).toContain("slow-step");
  });

  it("records the step name in the result", async () => {
    const step = createShellStep("named-shell-step", ["echo", "x"]);
    const result = await step.execute(makeCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stepName).toBe("named-shell-step");
  });

  it("records a non-negative durationMs in the result", async () => {
    const step = createShellStep("timed-step", ["echo", "y"]);
    const result = await step.execute(makeCtx());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });
});
