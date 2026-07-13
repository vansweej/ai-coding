import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { detectResumeState, resetToPhaseCommit } from "./resume";

describe("resume", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join("/tmp", "resume-test-"));
    // Initialize a git repo
    await $`git init`.cwd(tempDir).quiet();
    await $`git config user.email "test@example.com"`.cwd(tempDir).quiet();
    await $`git config user.name "Test User"`.cwd(tempDir).quiet();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("detectResumeState", () => {
    it("returns needsResume=false when git is clean", async () => {
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
