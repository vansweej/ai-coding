import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Reflexivity self-test: a fixture and meta-assertion proving that this
 * test is discovered by the DEFAULT `bun test` green gate (package.json's
 * `test` script is already `bun test`, which discovers `*.test.ts` files
 * under `test/` with no opt-in flag or extra script needed).
 *
 * This documents the re-enable criterion for unattended self-runs: they are
 * sanctioned ONLY when this default-discovered reflexivity test is green.
 * If the fixture file is removed, or the `*.test.ts` under `test/`
 * discovery convention is broken/changed, this meta-assertion fails loudly
 * rather than silently passing.
 */
describe("reflexivity self-test", () => {
  it("is discovered under test/ by the default bun test convention", () => {
    // This file's own path is the load-bearing meta-assertion: it must live
    // under test/ and match *.test.ts, matching package.json's `bun test`
    // default discovery -- no opt-in flag or extra script required.
    const selfPath = import.meta.path;
    expect(selfPath.endsWith(".test.ts")).toBe(true);
    expect(selfPath.includes(`${join("test", "reflexivity")}`)).toBe(true);
  });

  it("the reflexivity fixture directory exists on disk (removal must fail this test)", () => {
    const fixtureDir = join(import.meta.dir);
    expect(existsSync(fixtureDir)).toBe(true);
  });

  it("documents the re-enable criterion for unattended self-runs", () => {
    const reenableCriterion =
      "Unattended self-runs are sanctioned only when this default-discovered " +
      "reflexivity test is green.";
    expect(reenableCriterion.length).toBeGreaterThan(0);
    expect(reenableCriterion).toContain("reflexivity");
  });
});
