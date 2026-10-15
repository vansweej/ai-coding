import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { recordAttempt, revertToBest } from "./best-so-far";
import type { ProgressScore } from "./progress-score";

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "plans"), { recursive: true });
  writeFileSync(join(dir, "src/index.ts"), 'export const value = "partial";\n');
  writeFileSync(join(dir, "plans/keep.md"), "keep\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: dir });
}

function score(gateIndex: number): ProgressScore {
  return { gateIndex, gateSignature: "typecheck,test" };
}

describe("best-so-far", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "best-so-far-"));
    gitInit(workspace);
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("leaves the previous best unchanged in a non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "best-so-far-nongit-"));
    const previous = {
      tree: "a".repeat(40),
      score: score(1),
      attempt: 0,
      band: "local" as const,
      error: new Error("best"),
    };
    try {
      expect(recordAttempt(nonGit, score(0), new Error("failed"), 1, "local", previous)).toBe(
        previous,
      );
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("records the current tracked and untracked tree", () => {
    writeFileSync(join(workspace, "src/index.ts"), 'export const value = "best";\n');
    writeFileSync(join(workspace, "src/extra.ts"), "export {};\n");
    const best = recordAttempt(workspace, score(1), new Error("best"), 0, "local", undefined);
    expect(best).toBeDefined();
    expect(best?.tree).toMatch(/^[0-9a-f]{40}$/);
  });

  it("keeps only strict regressions from replacing the most recent best", () => {
    const first = recordAttempt(workspace, score(1), new Error("first"), 0, "local", undefined);
    if (first === undefined) throw new Error("Expected a first best");
    const same = recordAttempt(workspace, score(1), new Error("same"), 1, "local", first);
    const worse = recordAttempt(workspace, score(0), new Error("worse"), 2, "local", same);
    const better = recordAttempt(workspace, score(2), new Error("better"), 3, "local", worse);
    expect(same).not.toBe(first);
    expect(worse).toBe(same);
    expect(better).not.toBe(worse);
  });

  it("restores a regressed tree while preserving plans and an unstaged index", () => {
    writeFileSync(join(workspace, "src/index.ts"), 'export const value = "best";\n');
    writeFileSync(join(workspace, "src/extra.ts"), "export {};\n");
    const best = recordAttempt(workspace, score(1), new Error("best"), 0, "local", undefined);
    if (best === undefined) throw new Error("Expected best");
    writeFileSync(join(workspace, "src/index.ts"), 'export const value = "worse";\n');
    writeFileSync(join(workspace, "src/worse-only.ts"), "export {};\n");
    const result = revertToBest({
      workspace,
      phase: 1,
      attempt: 1,
      band: "local",
      best,
      current: score(0),
    });
    expect(result.reverted).toBe(true);
    expect(readFileSync(join(workspace, "src/index.ts"), "utf8")).toContain("best");
    expect(existsSync(join(workspace, "src/worse-only.ts"))).toBe(false);
    expect(existsSync(join(workspace, "src/extra.ts"))).toBe(true);
    expect(existsSync(join(workspace, "plans/keep.md"))).toBe(true);
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: workspace }).toString(),
    ).toBe("");
  });

  it("does not restore for incomparable, same, or better scores", () => {
    const best = recordAttempt(workspace, score(1), new Error("best"), 0, "local", undefined);
    if (best === undefined) throw new Error("Expected best");
    writeFileSync(join(workspace, "src/worse-only.ts"), "export {};\n");
    for (const current of [{ gateIndex: 0, gateSignature: "typecheck" }, score(1), score(2)]) {
      expect(
        revertToBest({ workspace, phase: 1, attempt: 1, band: "local", best, current }).reverted,
      ).toBe(false);
    }
    expect(existsSync(join(workspace, "src/worse-only.ts"))).toBe(true);
  });

  it("captures a snapshot before a restore when a run id is provided", () => {
    const best = recordAttempt(workspace, score(1), new Error("best"), 0, "local", undefined);
    if (best === undefined) throw new Error("Expected best");
    writeFileSync(join(workspace, "src/index.ts"), 'export const value = "worse";\n');
    expect(
      revertToBest({
        workspace,
        runId: "test-run",
        phase: 1,
        attempt: 1,
        band: "local",
        best,
        current: score(0),
      }).snapshot?.ok,
    ).toBe(true);
  });
});
