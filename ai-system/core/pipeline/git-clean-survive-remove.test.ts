import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";

import { restoreWorkingTree } from "./phase-runner";

/**
 * Positive/negative behavioral tests for `restoreWorkingTree`'s plan-file
 * exclusion, exercising the REAL `execFileSync` / git code path against a
 * real temporary git repository. A mock would reopen the false-green door
 * because it would not prove the file actually survives a real `git clean`.
 */
describe("restoreWorkingTree: plan-file survive/remove behavioral tests (real git)", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = mkdtempSync(join(tmpdir(), "git-clean-behavioral-test-"));
    await $`git init -b main`.cwd(workspace).quiet();
    await $`git config user.email "test@example.com"`.cwd(workspace).quiet();
    await $`git config user.name "Test User"`.cwd(workspace).quiet();

    // Seed a tracked file and commit so HEAD exists (required for `git reset --hard HEAD`).
    writeFileSync(join(workspace, "README.md"), "# test\n", "utf8");
    await $`git add README.md`.cwd(workspace).quiet();
    await $`git commit -m "seed"`.cwd(workspace).quiet();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("positive: the active plan file survives git clean when its path is passed as planPath", () => {
    // The plan file is untracked (not committed) and would normally be removed
    // by `git clean -fd`. With planPath set, `buildGitCleanArgs` emits
    // `-e <planPath>` so `git clean` skips it.
    const planPath = "PLAN.md";
    writeFileSync(join(workspace, planPath), "# Feature: survive test\n", "utf8");

    restoreWorkingTree(workspace, 1, undefined, planPath);

    expect(existsSync(join(workspace, planPath))).toBe(true);
  });

  it("negative: a non-excluded untracked file is removed by git clean", () => {
    // An untracked file with no corresponding `-e` exclusion must be removed
    // by `git clean -fd`. This is the complement of the positive case: proves
    // the exclusion is the mechanism, not that git clean silently no-ops.
    const untracked = "should-be-removed.tmp";
    writeFileSync(join(workspace, untracked), "temporary\n", "utf8");

    restoreWorkingTree(workspace, 1, undefined, undefined);

    expect(existsSync(join(workspace, untracked))).toBe(false);
  });

  it("positive + negative in one repo: plan file survives while a sibling untracked file is removed", () => {
    // Both cases in a single repo run: proves the exclusion is selective
    // (only the named plan path is preserved, not all untracked files).
    const planPath = "plans/feature.md";
    const sibling = "not-excluded.tmp";

    mkdirSync(join(workspace, "plans"), { recursive: true });
    writeFileSync(join(workspace, planPath), "# Feature: combined test\n", "utf8");
    writeFileSync(join(workspace, sibling), "remove me\n", "utf8");

    restoreWorkingTree(workspace, 1, undefined, planPath);

    expect(existsSync(join(workspace, planPath))).toBe(true);
    expect(existsSync(join(workspace, sibling))).toBe(false);
  });
});
