import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import { captureSnapshot, writeWorkingTreeObject } from "./snapshot";

/**
 * Behavioral tests for the forensic snapshot module, exercising the REAL
 * git/filesystem code paths against a real temporary git repository and a
 * temp HOME, so snapshot files never land under the real
 * ~/.local/share/ai-coding.
 */
describe("captureSnapshot / writeWorkingTreeObject", () => {
  let originalHome: string | undefined;
  let tempHome: string;
  let workspace: string;

  beforeEach(async () => {
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "snap-home-"));
    process.env.HOME = tempHome;

    workspace = mkdtempSync(join(tmpdir(), "snap-workspace-"));
    await $`git init -b main`.cwd(workspace).quiet();
    await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
    await $`git config user.name "Test User"`.cwd(workspace).quiet();

    writeFileSync(join(workspace, "README.md"), "# seed\n", "utf8");
    await $`git add README.md`.cwd(workspace).quiet();
    await $`git commit -m "seed"`.cwd(workspace).quiet();

    // Dirty the tree: modify the tracked file and add an untracked file.
    writeFileSync(join(workspace, "README.md"), "# seed\nmodified\n", "utf8");
    writeFileSync(join(workspace, "untracked.txt"), "new\n", "utf8");
  });

  afterEach(() => {
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it("captures a snapshot with a tree SHA, non-empty patch, and status under the temp HOME", () => {
    const outcome = captureSnapshot({
      workspace,
      runId: "run-1",
      phase: 1,
      label: "verification-failed",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.patchBytes).toBeGreaterThan(0);
    expect(outcome.dir.startsWith(tempHome)).toBe(true);

    expect(existsSync(join(outcome.dir, "changes.patch"))).toBe(true);
    expect(existsSync(join(outcome.dir, "status.txt"))).toBe(true);

    const status = readFileSync(join(outcome.dir, "status.txt"), "utf8");
    expect(status.length).toBeGreaterThan(0);
  });

  it("does not modify the real tree or index", async () => {
    const before = await $`git status --porcelain`.cwd(workspace).quiet().text();

    captureSnapshot({ workspace, runId: "run-2", phase: 1, label: "no-net-change" });

    const after = await $`git status --porcelain`.cwd(workspace).quiet().text();
    expect(after).toBe(before);
  });

  it("writeWorkingTreeObject returns a hex tree SHA for a real repo", () => {
    const result = writeWorkingTreeObject(workspace);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns ok: false (no throw) from both functions for a non-git directory", () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "snap-nongit-"));
    try {
      const treeResult = writeWorkingTreeObject(nonGitDir);
      expect(treeResult.ok).toBe(false);

      const snapshotResult = captureSnapshot({
        workspace: nonGitDir,
        runId: "run-3",
        phase: 1,
        label: "assertion-failed",
      });
      expect(snapshotResult.ok).toBe(false);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });
});
