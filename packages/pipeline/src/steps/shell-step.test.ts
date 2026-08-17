import { describe, expect, it } from "bun:test";

import { createShellStep } from "./shell-step";

/** Minimal test event -- shell step does not use context. */
interface TestEvent {
  readonly id: string;
}

const testCtx = {
  event: { id: "test" } as TestEvent,
  results: new Map(),
};

describe("createShellStep", () => {
  it("captures stdout from a successful command", async () => {
    const step = createShellStep<TestEvent>("echo-step", ["echo", "hello"]);
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output.trim()).toBe("hello");
  });

  it("returns error on non-zero exit code by default", async () => {
    const step = createShellStep<TestEvent>("fail-step", ["false"]);
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("exited with code 1");
    expect(result.error.message).toContain("fail-step");
  });

  it("includes stderr in the error message on failure", async () => {
    const step = createShellStep<TestEvent>("err-step", ["sh", "-c", "echo my-error >&2; exit 1"]);
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("my-error");
  });

  it("succeeds with non-zero exit when failOnNonZero is false", async () => {
    const step = createShellStep<TestEvent>("lenient-step", ["sh", "-c", "echo output; exit 1"], {
      failOnNonZero: false,
    });
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output.trim()).toBe("output");
  });

  it("returns error when command times out", async () => {
    const step = createShellStep<TestEvent>("slow-step", ["sleep", "10"], { timeoutMs: 50 });
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("timed out");
    expect(result.error.message).toContain("slow-step");
  });

  it("records the step name in the result", async () => {
    const step = createShellStep<TestEvent>("named-shell-step", ["echo", "x"]);
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stepName).toBe("named-shell-step");
  });

  it("records a non-negative durationMs in the result", async () => {
    const step = createShellStep<TestEvent>("timed-step", ["echo", "y"]);
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("includes both stdout and stderr in the output", async () => {
    const step = createShellStep<TestEvent>("combined-step", [
      "sh",
      "-c",
      "echo to-out; echo to-err >&2",
    ]);
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toContain("to-out");
    expect(result.value.output).toContain("to-err");
  });

  it("returns empty output when command prints nothing", async () => {
    const step = createShellStep<TestEvent>("silent-step", ["true"]);
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toBe("");
  });

  it("fires onGateOutput with real captured values on success", async () => {
    const calls: Array<{
      name: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      durationMs: number;
    }> = [];
    const step = createShellStep<TestEvent>("ok-gate", ["true"], {
      onGateOutput: (name, stdout, stderr, exitCode, durationMs) => {
        calls.push({ name, stdout, stderr, exitCode, durationMs });
      },
    });
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("ok-gate");
    expect(calls[0]?.exitCode).toBe(0);
    expect(calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fires onGateOutput exactly once with the real non-zero exit code even when the step itself fails", async () => {
    const calls: Array<{
      name: string;
      stdout: string;
      stderr: string;
      exitCode: number;
      durationMs: number;
    }> = [];
    const step = createShellStep<TestEvent>("fail-gate", ["sh", "-c", "echo boom >&2; exit 1"], {
      onGateOutput: (name, stdout, stderr, exitCode, durationMs) => {
        calls.push({ name, stdout, stderr, exitCode, durationMs });
      },
    });
    const result = await step.execute(testCtx);

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("fail-gate");
    expect(calls[0]?.exitCode).toBe(1);
    expect(calls[0]?.stderr).toContain("boom");
    expect(calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });
});
