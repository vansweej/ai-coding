import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { commitPhaseChanges } from "./phase-runner";

describe("commitPhaseChanges (commit hash provenance)", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "commit-hash-provenance-test-"));
    execSync("git init", { cwd: workspace, encoding: "utf8" });
    execSync('git config user.email "test@example.com"', { cwd: workspace, encoding: "utf8" });
    execSync('git config user.name "Test User"', { cwd: workspace, encoding: "utf8" });
    writeFileSync(join(workspace, "file.txt"), "hello\n", "utf8");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns a 40-char lowercase hex SHA matching git rev-parse HEAD, with Phase/Run-Id trailers", async () => {
    const result = await commitPhaseChanges(
      workspace,
      "feat: add provenance test",
      1,
      "run-test-abc",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toMatch(/^[0-9a-f]{40}$/);

    const headSha = execSync("git rev-parse HEAD", { cwd: workspace, encoding: "utf8" }).trim();
    expect(result.value).toBe(headSha);

    const commitBody = execSync("git log -1 --format=%B", {
      cwd: workspace,
      encoding: "utf8",
    });
    expect(commitBody).toMatch(/Phase:\s*1/);
    expect(commitBody).toMatch(/Run-Id:\s*run-test-abc/);
  });
});
