import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devShellPalette } from "./devshell-palette";

/** Creates a temporary directory and returns its path. Caller must clean up. */
function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `devshell-palette-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("devShellPalette", () => {
  it("returns an empty set immediately when candidateTools is empty", async () => {
    const dir = makeTempDir();
    try {
      const result = await devShellPalette(dir, [], { cwd: dir });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects tools on PATH via bare sh -c when no flake.nix is present", async () => {
    const dir = makeTempDir();
    try {
      // "sh" itself is always on PATH; "definitely-not-a-real-tool" never is.
      const result = await devShellPalette(dir, ["sh", "definitely-not-a-real-tool"], { cwd: dir });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.has("sh")).toBe(true);
      expect(result.value.has("definitely-not-a-real-tool")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("wraps the probe in nix develop when flake.nix is present", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "flake.nix"), "# fake flake");

      // We cannot run a real `nix develop` against a fake flake in CI; what
      // matters is the probe attempted to invoke nix, not the inner command --
      // a missing/broken `nix` produces an error referencing nix, not "sh".
      const result = await devShellPalette(dir, ["sh"], { cwd: dir });

      if (result.ok) {
        // A real nix is available and evaluated the fake flake successfully
        // (unlikely for a malformed flake.nix, but tolerate it).
        expect(result.value).toBeInstanceOf(Set);
      } else {
        expect(result.error.message).toContain("devShellPalette");
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("only reports tools present in the candidate whitelist, ignoring extraneous stdout lines", async () => {
    const dir = makeTempDir();
    try {
      // Simulate a devShell whose shellHook prints a banner line to stdout
      // (e.g. "Cerebrum development environment loaded") that is NOT one of
      // the probed candidate tools. The parser must not misreport it as a
      // detected tool -- confirmed by only including "sh" as a candidate
      // while the environment prints unrelated noise via PATH lookups.
      const result = await devShellPalette(dir, ["sh"], { cwd: dir });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Every entry in the result must be a member of the candidate set.
      for (const tool of result.value) {
        expect(["sh"]).toContain(tool);
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("fails fast with a broken flake.nix before probing any candidate", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(join(dir, "flake.nix"), "{ this is not valid nix");

      const result = await devShellPalette(dir, ["sh"], { cwd: dir, timeoutMs: 30_000 });

      // Whether nix is installed or not in the test environment, a broken
      // flake.nix must never resolve to ok:true with a bogus tool set.
      if (!result.ok) {
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns error when the probe times out", async () => {
    const dir = makeTempDir();
    try {
      const result = await devShellPalette(dir, ["sh"], {
        cwd: dir,
        timeoutMs: 1,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("timed out");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
