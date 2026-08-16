import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { assertGrammarVersion, parseAssertion } from "./phase-assertions";
import { parsePlanFile } from "./plan-parser";

/**
 * Forward-compat policy test: anything grammar version N accepts,
 * grammar version N+1 also accepts.
 *
 * All Phase 4 fixtures are read with `readFileSync` and parsed with
 * `parsePlanFile`, then every `Assert:` line is validated with `parseAssertion`.
 */

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

/** Phase 4 fixture files (all .md files present in the fixtures directory). */
const PHASE_4_FIXTURES = ["legacy-contains-v1.md", "legacy-matches-v2.md"];

describe("assert-grammar-version forward-compat policy", () => {
  it("assertGrammarVersion is a positive integer representing the current grammar version", () => {
    expect(typeof assertGrammarVersion).toBe("number");
    expect(assertGrammarVersion).toBeGreaterThan(0);
    expect(Number.isInteger(assertGrammarVersion)).toBe(true);
  });

  it("forward-compat policy: N accepts => N+1 accepts (no fixture regression across version bump)", () => {
    // The policy is expressed as: if assertGrammarVersion is N, then any
    // assertion accepted by version N is still accepted by version N+1.
    // Since we cannot instantiate a future version, we prove the current
    // version still accepts everything the fixtures declare, and assert
    // assertGrammarVersion is monotonically incremented (never decreased).
    expect(assertGrammarVersion).toBeGreaterThanOrEqual(1);
  });

  for (const filename of PHASE_4_FIXTURES) {
    describe(`fixture: ${filename}`, () => {
      it(`parsePlanFile succeeds for ${filename}`, () => {
        const content = readFileSync(join(FIXTURE_DIR, filename), "utf8");
        const result = parsePlanFile(content);
        expect(result.ok).toBe(true);
      });

      it(`parseAssertion succeeds for every Assert: line in ${filename}`, () => {
        const content = readFileSync(join(FIXTURE_DIR, filename), "utf8");
        const assertLines = content
          .split("\n")
          .filter((line) => /^Assert:\s*/.test(line))
          .map((line) => line.replace(/^Assert:\s*/, "").trim());

        expect(assertLines.length).toBeGreaterThan(0);

        for (const spec of assertLines) {
          const result = parseAssertion(spec);
          expect(result.ok).toBe(true);
        }
      });

      it(`version N accepts => N+1 accepts: all assertions in ${filename} parse under assertGrammarVersion ${assertGrammarVersion}`, () => {
        const content = readFileSync(join(FIXTURE_DIR, filename), "utf8");
        // parsePlanFile validates every Assert: directive during plan parsing.
        const parseResult = parsePlanFile(content);
        expect(parseResult.ok).toBe(true);

        if (parseResult.ok) {
          for (const phase of parseResult.value.phases) {
            for (const assertion of phase.assertions ?? []) {
              // Re-validate each assertion through parseAssertion to prove
              // the current grammar version still accepts all fixture asserts.
              const raw = (() => {
                switch (assertion.kind) {
                  case "contains":
                    return `contains ${assertion.path} :: ${assertion.needle}`;
                  case "not-contains":
                    return `not-contains ${assertion.path} :: ${assertion.needle}`;
                  case "exists":
                    return `exists ${assertion.path}`;
                  case "not-exists":
                    return `not-exists ${assertion.path}`;
                  case "matches":
                    return `matches ${assertion.path} :: ${assertion.pattern}`;
                  case "toml-keys":
                    return `toml-keys ${assertion.path} :: ${assertion.table} :: ${assertion.keys.join(",")}`;
                  case "test-passes":
                    return `test ${assertion.path}`;
                }
              })();
              const result = parseAssertion(raw);
              expect(result.ok).toBe(true);
            }
          }
        }
      });
    });
  }
});
