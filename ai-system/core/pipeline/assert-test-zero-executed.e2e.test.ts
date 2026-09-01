import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

import { evaluateBunTestOutcome, parseBunTestCounts } from "./parse-bun-test-counts";
import { checkAssertions } from "./phase-assertions";

/**
 * Real-run (no-mock) integration tests for the `Assert: test <path>` verb,
 * specifically pinning down the zero-executed-tests failure mode against
 * REAL `bun test` subprocess output (not a hardcoded captured-output
 * constant), following the exact same nested-`bun test`-from-`bun test`
 * pattern already proven safe by phase-assertions.test-verb.test.ts.
 *
 * Bun version recorded at authoring time: 1.3.13 (bf2e2cec).
 */
describe("assert-test-zero-executed e2e", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "assert-test-zero-executed-e2e-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a one-test passing fixture satisfies the test verb", async () => {
    const fixturePath = join(tempDir, "one.test.ts");
    writeFileSync(
      fixturePath,
      'import { describe, expect, it } from "bun:test";\ndescribe("one", () => { it("runs one assertion", () => { expect(1).toBe(1); }); });\n',
      "utf8",
    );

    const result = await checkAssertions(tempDir, [{ kind: "test-passes", path: fixturePath }]);
    expect(result.ok).toBe(true);
  });

  it("a zero-test fixture is rejected by the test verb", async () => {
    const fixturePath = join(tempDir, "zero.test.ts");
    writeFileSync(
      fixturePath,
      'import { describe, expect } from "bun:test";\n// deliberately zero it() blocks\n',
      "utf8",
    );

    const result = await checkAssertions(tempDir, [{ kind: "test-passes", path: fixturePath }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        `Structural assertion failed: test "${fixturePath}" executed zero tests (bun test reported no executed tests; an empty, skip-only, or todo-only test file cannot satisfy this assertion)`,
      );
    }
  });

  it("a skip-only fixture is rejected by the test verb", async () => {
    const fixturePath = join(tempDir, "skip.test.ts");
    writeFileSync(
      fixturePath,
      'import { describe, it } from "bun:test";\ndescribe("skip", () => { it.skip("skipped case", () => {}); });\n',
      "utf8",
    );

    const result = await checkAssertions(tempDir, [{ kind: "test-passes", path: fixturePath }]);
    expect(result.ok).toBe(false);
  });

  it("parseBunTestCounts strictly parses the real bun output of a one-test fixture", async () => {
    const fixturePath = join(tempDir, "one-real.test.ts");
    writeFileSync(
      fixturePath,
      'import { describe, expect, it } from "bun:test";\ndescribe("one-real", () => { it("runs one assertion", () => { expect(1).toBe(1); }); });\n',
      "utf8",
    );

    const proc = await $`bun test ${fixturePath}`.cwd(tempDir).nothrow().quiet();
    const realOutput = `${proc.stdout.toString()}${proc.stderr.toString()}`;

    const counts = parseBunTestCounts(realOutput);
    expect(counts.parsed).toBe(true);
    expect(counts.executed).toBe(1);
  });

  it("evaluateBunTestOutcome rejects the real bun output of a zero-test fixture", async () => {
    const fixturePath = join(tempDir, "zero-real.test.ts");
    writeFileSync(
      fixturePath,
      'import { describe, expect } from "bun:test";\n// deliberately zero it() blocks\n',
      "utf8",
    );

    const proc = await $`bun test ${fixturePath}`.cwd(tempDir).nothrow().quiet();
    const realOutput = `${proc.stdout.toString()}${proc.stderr.toString()}`;

    const counts = parseBunTestCounts(realOutput);
    expect(counts.parsed).toBe(true);
    expect(counts.executed).toBe(0);

    const outcome = evaluateBunTestOutcome(realOutput, fixturePath);
    expect(outcome.ok).toBe(false);
  });
});
