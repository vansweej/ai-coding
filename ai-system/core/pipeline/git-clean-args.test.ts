import { describe, expect, it } from "bun:test";
import { buildGitCleanArgs } from "./git-clean-args";

describe("buildGitCleanArgs", () => {
  it("returns the blanket plans/ guard when no planPath is provided", () => {
    expect(buildGitCleanArgs("/repo")).toEqual(["clean", "-fd", "-e", "plans/"]);
  });

  it("appends -e <relative path> when planPath is inside repoRoot, under plans/", () => {
    expect(buildGitCleanArgs("/repo", "/repo/plans/feature.md")).toEqual([
      "clean",
      "-fd",
      "-e",
      "plans/",
      "-e",
      "plans/feature.md",
    ]);
  });

  it("appends -e <relative path> when planPath is inside repoRoot, outside plans/", () => {
    expect(buildGitCleanArgs("/repo", "/repo/docs/my-plan.md")).toEqual([
      "clean",
      "-fd",
      "-e",
      "plans/",
      "-e",
      "docs/my-plan.md",
    ]);
  });

  it("does not append a second exclusion when planPath is outside repoRoot", () => {
    expect(buildGitCleanArgs("/repo", "/elsewhere/plan.md")).toEqual([
      "clean",
      "-fd",
      "-e",
      "plans/",
    ]);
  });

  it("resolves a relative planPath against repoRoot", () => {
    expect(buildGitCleanArgs("/repo", "plans/feature.md")).toEqual([
      "clean",
      "-fd",
      "-e",
      "plans/",
      "-e",
      "plans/feature.md",
    ]);
  });

  it("normalizes backslashes to forward slashes in the relative path", () => {
    // On POSIX this is a no-op; the split/join guards Windows-style separators
    // without needing a platform-specific test double.
    const args = buildGitCleanArgs("/repo", "/repo/docs/my-plan.md");
    const eIdx = args.lastIndexOf("-e");
    expect(args[eIdx + 1]).not.toContain("\\");
  });

  it("treats repoRoot itself as planPath as outside (empty relative path is not appended)", () => {
    expect(buildGitCleanArgs("/repo", "/repo")).toEqual(["clean", "-fd", "-e", "plans/"]);
  });
});
