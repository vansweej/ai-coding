import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { parseAssertion } from "./phase-assertions";
import { parsePlanFile } from "./plan-parser";

const FIXTURE_DIR = join(import.meta.dir, "fixtures");

/**
 * Regression suite that loads both legacy fixture plan files and verifies
 * every `parsePlanFile` and `parseAssertion` call succeeds, confirming all
 * 6 grammar verbs (3 per fixture, per Steps 1–2) parse without error.
 */
describe("legacy-fixtures regression", () => {
  const fixtureFiles = [
    "legacy-contains-v1.md",
    "legacy-assertions-v1.md",
  ];

  for (const filename of fixtureFiles) {
    it(`parsePlanFile succeeds for ${filename}`, () => {
      const content = readFileSync(join(FIXTURE_DIR, filename), "utf8");
      const result = parsePlanFile(content);
      expect(result.ok).toBe(true);
    });

    it(`parseAssertion succeeds for every assert line in ${filename}`, () => {
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
  }
});