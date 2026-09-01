import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

import { classifyResumeScan } from "./resume";

describe("classifyResumeScan", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "resume-scan-test-"));
    await $`git init -b main`.cwd(tempDir).quiet();
    await $`git config user.email "test@example.com"`.cwd(tempDir).quiet();
    await $`git config user.name "Test User"`.cwd(tempDir).quiet();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns both undefined when no Phase: trailer is present anywhere", async () => {
    await $`echo "test" > file.txt`.cwd(tempDir).quiet();
    await $`git add file.txt`.cwd(tempDir).quiet();
    await $`git commit -m "initial commit, no trailer"`.cwd(tempDir).quiet();

    const result = await classifyResumeScan(tempDir);
    expect(result.lastPhaseNumber).toBeUndefined();
    expect(result.targetSubject).toBeUndefined();
  });

  it("returns targetSubject undefined when the reset target commit carries a Run-Id trailer", async () => {
    await $`echo "1" > file.txt`.cwd(tempDir).quiet();
    await $`git add file.txt`.cwd(tempDir).quiet();
    await $`git commit -m ${"feat: phase 1\n\nPhase: 1\nRun-Id: run-abc123"}`.cwd(tempDir).quiet();

    const result = await classifyResumeScan(tempDir);
    expect(result.lastPhaseNumber).toBe(1);
    expect(result.targetSubject).toBeUndefined();
  });

  it("returns targetSubject equal to the commit's subject line when the reset target lacks Run-Id", async () => {
    await $`echo "1" > file.txt`.cwd(tempDir).quiet();
    await $`git add file.txt`.cwd(tempDir).quiet();
    await $`git commit -m ${"feat: phase 1 without run id\n\nPhase: 1"}`.cwd(tempDir).quiet();

    const result = await classifyResumeScan(tempDir);
    expect(result.lastPhaseNumber).toBe(1);
    expect(result.targetSubject).toBe("feat: phase 1 without run id");
  });

  it("ignores a lower-numbered phase commit's missing Run-Id when the highest-numbered one has it", async () => {
    await $`echo "1" > file.txt`.cwd(tempDir).quiet();
    await $`git add file.txt`.cwd(tempDir).quiet();
    await $`git commit -m ${"feat: phase 1 no run id\n\nPhase: 1"}`.cwd(tempDir).quiet();

    await $`echo "2" > file.txt`.cwd(tempDir).quiet();
    await $`git add file.txt`.cwd(tempDir).quiet();
    await $`git commit -m ${"feat: phase 2 with run id\n\nPhase: 2\nRun-Id: run-xyz789"}`
      .cwd(tempDir)
      .quiet();

    const result = await classifyResumeScan(tempDir);
    expect(result.lastPhaseNumber).toBe(2);
    expect(result.targetSubject).toBeUndefined();
  });

  it("selects the highest Phase: N regardless of commit order", async () => {
    await $`echo "1" > file.txt`.cwd(tempDir).quiet();
    await $`git add file.txt`.cwd(tempDir).quiet();
    await $`git commit -m ${"feat: phase 1\n\nPhase: 1\nRun-Id: run-a"}`.cwd(tempDir).quiet();

    await $`echo "2" > file.txt`.cwd(tempDir).quiet();
    await $`git add file.txt`.cwd(tempDir).quiet();
    await $`git commit -m ${"feat: phase 3\n\nPhase: 3\nRun-Id: run-b"}`.cwd(tempDir).quiet();

    await $`echo "3" > file.txt`.cwd(tempDir).quiet();
    await $`git add file.txt`.cwd(tempDir).quiet();
    await $`git commit -m ${"feat: phase 2\n\nPhase: 2\nRun-Id: run-c"}`.cwd(tempDir).quiet();

    const result = await classifyResumeScan(tempDir);
    expect(result.lastPhaseNumber).toBe(3);
  });
});
