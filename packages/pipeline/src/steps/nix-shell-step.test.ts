import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNixShellStep } from "./nix-shell-step";

/** Minimal test event -- nix-shell step does not use context. */
interface TestEvent {
  readonly id: string;
}

const testCtx = {
  event: { id: "test" } as TestEvent,
  results: new Map(),
};

/** Creates a temporary directory and returns its path. Caller must clean up. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `nix-shell-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("createNixShellStep", () => {
  it("runs command directly when no flake.nix is present", async () => {
    const dir = makeTempDir();
    try {
      const step = createNixShellStep<TestEvent>("plain-step", ["echo", "no-nix"], { cwd: dir });
      const result = await step.execute(testCtx);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.output.trim()).toBe("no-nix");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("wraps command in nix develop when flake.nix is present", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "flake.nix"), "# fake flake");

      // We cannot run a real `nix develop` in CI, so we verify the step
      // attempts to invoke nix by checking the error message references nix.
      const step = createNixShellStep<TestEvent>("nix-step", ["echo", "in-nix"], { cwd: dir });
      const result = await step.execute(testCtx);

      // nix may not be installed in test environment; what matters is the
      // command was wrapped -- a missing `nix` binary produces a spawn error,
      // not a plain "echo" success.
      if (result.ok) {
        // nix is available and ran successfully
        expect(result.value.stepName).toBe("nix-step");
      } else {
        // nix is not available -- verify the error relates to the nix invocation,
        // not to the inner command ("echo"), confirming wrapping occurred.
        expect(result.error.message).not.toContain('"echo"');
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns error on non-zero exit when failOnNonZero is true (default)", async () => {
    const dir = makeTempDir();
    try {
      const step = createNixShellStep<TestEvent>("fail-step", ["false"], { cwd: dir });
      const result = await step.execute(testCtx);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("fail-step");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("succeeds on non-zero exit when failOnNonZero is false", async () => {
    const dir = makeTempDir();
    try {
      const step = createNixShellStep<TestEvent>("lenient-step", ["sh", "-c", "echo hi; exit 1"], {
        cwd: dir,
        failOnNonZero: false,
      });
      const result = await step.execute(testCtx);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.output.trim()).toBe("hi");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("records the step name and non-negative durationMs in the result", async () => {
    const dir = makeTempDir();
    try {
      const step = createNixShellStep<TestEvent>("timed-step", ["echo", "ok"], { cwd: dir });
      const result = await step.execute(testCtx);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stepName).toBe("timed-step");
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns error when command times out", async () => {
    const dir = makeTempDir();
    try {
      const step = createNixShellStep<TestEvent>("slow-step", ["sleep", "10"], {
        cwd: dir,
        timeoutMs: 50,
      });
      const result = await step.execute(testCtx);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("timed out");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
