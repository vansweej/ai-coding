import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { checkAssertions, parseAssertion } from "./phase-assertions";

/**
 * Tests for the `test-passes` assertion verb.
 *
 * Both the passing fixture and the failing fixture are written to OS temp
 * directories at runtime and never committed into the repo tree, so they
 * cannot poison the `bun test` gate for this phase.
 */
describe("checkAssertions (test-passes verb)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "phase-assertions-test-verb-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("test-passes returns ok:true for a passing bun:test fixture", async () => {
    const fixturePath = join(tempDir, "passing.test.ts");
    writeFileSync(
      fixturePath,
      `import { describe, expect, it } from "bun:test";\ndescribe("passing", () => { it("passes", () => { expect(1).toBe(1); }); });\n`,
      "utf8",
    );

    const result = await checkAssertions(tempDir, [{ kind: "test-passes", path: fixturePath }]);
    expect(result.ok).toBe(true);
  });

  it("test-passes returns ok:false for a failing bun:test fixture", async () => {
    const fixturePath = join(tempDir, "failing.test.ts");
    writeFileSync(
      fixturePath,
      `import { describe, expect, it } from "bun:test";\ndescribe("failing", () => { it("fails", () => { expect(1).toBe(2); }); });\n`,
      "utf8",
    );

    const result = await checkAssertions(tempDir, [{ kind: "test-passes", path: fixturePath }]);
    expect(result.ok).toBe(false);
  });

  it("test-passes returns ok:false when the fixture file does not exist", async () => {
    const missingPath = join(tempDir, "does-not-exist.test.ts");

    const result = await checkAssertions(tempDir, [{ kind: "test-passes", path: missingPath }]);
    expect(result.ok).toBe(false);
  });

  it("parseAssertion accepts the documented `test <path>` string grammar (not `test-passes`)", () => {
    // Regression test: the surface grammar documented in README.md, AGENTS.md,
    // docs/plan-cycle.md, and docs/architecture.md is `Assert: test <path>`.
    // A real plan file author writes the verb `test`, never `test-passes`
    // (that string is only the internal PhaseAssertion.kind discriminant).
    // Every other test in this file constructs the PhaseAssertion object
    // directly and never exercises the string parser, so this is the only
    // test proving the documented grammar actually parses end-to-end.
    const result = parseAssertion("test src/parser.test.ts");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ kind: "test-passes", path: "src/parser.test.ts" });
    }
  });

  it("parseAssertion rejects an empty path for the `test` verb", () => {
    const result = parseAssertion("test ");
    expect(result.ok).toBe(false);
  });

  it("parseAssertion does NOT recognize the bare kind name `test-passes` as a verb", () => {
    // Guards against ever silently reverting to the wrong surface keyword.
    const result = parseAssertion("test-passes src/parser.test.ts");
    expect(result.ok).toBe(false);
  });
});
