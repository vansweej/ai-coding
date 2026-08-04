import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { detectResumeState, resetToPhaseCommit } from "./resume";

describe("resume", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join("/tmp", "resume-test-"));
    // Initialize a git repo with a deterministic trunk branch name --
    // resolveTrunkMergeBase compares the current branch name against
    // "main"/"master" candidates, so pin it explicitly rather than relying
    // on the host's init.defaultBranch config.
    await $`git init -b main`.cwd(tempDir).quiet();
    await $`git config user.email "test@example.com"`.cwd(tempDir).quiet();
    await $`git config user.name "Test User"`.cwd(tempDir).quiet();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("detectResumeState", () => {
    it("returns needsResume=false when clean and no Phase commits", async () => {
      // Create initial commit
      await $`echo "test" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "initial"`.cwd(tempDir).quiet();

      const state = await detectResumeState(tempDir);
      expect(state.needsResume).toBe(false);
      expect(state.lastPhaseNumber).toBeUndefined();
    });

    it("returns needsResume=false when dirty but no Phase commits", async () => {
      // Create initial commit
      await $`echo "test" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "initial"`.cwd(tempDir).quiet();

      // Make dirty
      await $`echo "modified" > file.txt`.cwd(tempDir).quiet();

      const state = await detectResumeState(tempDir);
      expect(state.needsResume).toBe(false);
      expect(state.lastPhaseNumber).toBeUndefined();
    });

    it("returns needsResume=true when dirty and Phase commit exists", async () => {
      // Create commit with Phase trailer
      await $`echo "test" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: phase 1\n\nPhase: 1"`.cwd(tempDir).quiet();

      // Make dirty
      await $`echo "modified" > file.txt`.cwd(tempDir).quiet();

      const state = await detectResumeState(tempDir);
      expect(state.needsResume).toBe(true);
      expect(state.lastPhaseNumber).toBe(1);
    });

    it("returns needsResume=true when CLEAN and a Phase commit exists", async () => {
      // Regression guard: a phase can fail and roll back to a clean tree
      // (patch application never partially writes), which must still be
      // treated as resumable -- otherwise the next run silently restarts
      // the whole feature from phase 1 instead of continuing past the last
      // completed phase.
      await $`echo "test" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: phase 1\n\nPhase: 1"`.cwd(tempDir).quiet();

      // Tree is clean -- no dirty changes.
      const state = await detectResumeState(tempDir);
      expect(state.needsResume).toBe(true);
      expect(state.lastPhaseNumber).toBe(1);
    });

    it("finds the most recent Phase commit when multiple exist", async () => {
      // Create multiple commits with Phase trailers
      await $`echo "1" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: phase 1\n\nPhase: 1"`.cwd(tempDir).quiet();

      await $`echo "2" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: phase 2\n\nPhase: 2"`.cwd(tempDir).quiet();

      await $`echo "3" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: phase 3\n\nPhase: 3"`.cwd(tempDir).quiet();

      // Make dirty
      await $`echo "modified" > file.txt`.cwd(tempDir).quiet();

      const state = await detectResumeState(tempDir);
      expect(state.needsResume).toBe(true);
      expect(state.lastPhaseNumber).toBe(3);
    });

    it("regression: does not adopt an unrelated Phase trailer from trunk history on a fresh feature branch", async () => {
      // Reproduces a production bug: main has old, already-merged Phase: N
      // commits from a completed feature. A brand-new feat/<slug> branch is
      // forked off main with ZERO commits of its own. Because the fork
      // point (merge-base) is bounded out of the search, detectResumeState
      // must NOT find main's old Phase: 7 trailer and must NOT report a
      // resume -- otherwise the fresh branch gets reset all the way back to
      // an ancestor of its own base, failing any "HEAD descends from base"
      // invariant a caller (e.g. choragos) enforces.
      await $`echo "1" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: old feature phase 1\n\nPhase: 1"`.cwd(tempDir).quiet();

      await $`echo "2" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "docs: old feature phase 7\n\nPhase: 7"`.cwd(tempDir).quiet();

      // Fork a fresh feature branch off main with no new commits -- exactly
      // what choragos does when it creates feat/<slug> from base_sha.
      await $`git checkout -b feat/new-thing`.cwd(tempDir).quiet();

      const state = await detectResumeState(tempDir);
      expect(state.needsResume).toBe(false);
      expect(state.lastPhaseNumber).toBeUndefined();
    });

    it("still detects a legitimate resume on a feature branch's own Phase commits", async () => {
      // The fix must not throw out real resume detection: commits made
      // AFTER the fork point, on the feature branch itself, must still be
      // found even though old unrelated Phase trailers exist on main too.
      await $`echo "1" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "docs: old feature phase 7\n\nPhase: 7"`.cwd(tempDir).quiet();

      await $`git checkout -b feat/new-thing`.cwd(tempDir).quiet();

      await $`echo "2" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: new thing phase 1\n\nPhase: 1"`.cwd(tempDir).quiet();

      const state = await detectResumeState(tempDir);
      expect(state.needsResume).toBe(true);
      expect(state.lastPhaseNumber).toBe(1);
    });
  });

  describe("resetToPhaseCommit", () => {
    it("resets to the commit with Phase: N trailer", async () => {
      // Create initial commit
      await $`echo "1" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: phase 1\n\nPhase: 1"`.cwd(tempDir).quiet();

      // Create second commit
      await $`echo "2" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: phase 2\n\nPhase: 2"`.cwd(tempDir).quiet();

      // Make dirty changes
      await $`echo "dirty" > file.txt`.cwd(tempDir).quiet();
      await $`echo "untracked" > untracked.txt`.cwd(tempDir).quiet();

      // Reset to phase 1
      const result = await resetToPhaseCommit(tempDir, 1);
      expect(result.ok).toBe(true);

      // Verify we're at phase 1
      const content = await $`cat file.txt`.cwd(tempDir).text();
      expect(content.trim()).toBe("1");

      // Verify untracked file is gone
      const status = await $`git status --porcelain`.cwd(tempDir).text();
      expect(status.trim()).toBe("");
    });

    it("returns error when Phase: N commit not found", async () => {
      // Create commit without Phase trailer
      await $`echo "test" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: no phase"`.cwd(tempDir).quiet();

      const result = await resetToPhaseCommit(tempDir, 99);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("No commit found with Phase: 99");
      }
    });

    it("cleans up untracked files during reset", async () => {
      // Create initial commit
      await $`echo "test" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      await $`git commit -m "feat: phase 1\n\nPhase: 1"`.cwd(tempDir).quiet();

      // Create untracked files
      await $`echo "untracked1" > untracked1.txt`.cwd(tempDir).quiet();
      await $`echo "untracked2" > untracked2.txt`.cwd(tempDir).quiet();

      const result = await resetToPhaseCommit(tempDir, 1);
      expect(result.ok).toBe(true);

      // Verify untracked files are gone
      const status = await $`git status --porcelain`.cwd(tempDir).text();
      expect(status.trim()).toBe("");
    });

    it("handles Phase: N with whitespace variations", async () => {
      // Create commit with various Phase trailer formats
      await $`echo "test" > file.txt`.cwd(tempDir).quiet();
      await $`git add file.txt`.cwd(tempDir).quiet();
      // Use printf to properly handle newlines in commit message
      await $`git commit -m ${"feat: phase 1\n\nPhase:  1"}`.cwd(tempDir).quiet();

      // Make dirty
      await $`echo "dirty" > file.txt`.cwd(tempDir).quiet();

      const result = await resetToPhaseCommit(tempDir, 1);
      expect(result.ok).toBe(true);

      const content = await $`cat file.txt`.cwd(tempDir).text();
      expect(content.trim()).toBe("test");
    });
  });
});
