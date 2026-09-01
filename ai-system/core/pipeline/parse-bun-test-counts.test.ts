import { describe, expect, it } from "bun:test";

import { evaluateBunTestOutcome, parseBunTestCounts } from "./parse-bun-test-counts";

const ONE_BLOB = `bun test v1.3.13 (bf2e2cec)

/tmp/.../one.test.ts:
(pass) one > runs one assertion

 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file. [24.00ms]
`;

const ZERO_BLOB = `bun test v1.3.13 (bf2e2cec)

/tmp/.../zero.test.ts:

 0 pass
 0 fail
Ran 0 tests across 1 file. [14.00ms]
`;

const SKIP_BLOB = `bun test v1.3.13 (bf2e2cec)

/tmp/.../skip.test.ts:
(skip) skip > skipped case

 0 pass
 1 skip
 0 fail
Ran 1 test across 1 file. [11.00ms]
`;

const TODO_BLOB = `bun test v1.3.13 (bf2e2cec)

/tmp/.../todo.test.ts:
(todo) todo > todo case

 0 pass
 1 todo
 0 fail
Ran 1 test across 1 file. [11.00ms]
`;

const MIXED_BLOB = `bun test v1.3.13 (bf2e2cec)

/tmp/.../mixed.test.ts:
(pass) mixed > a
(pass) mixed > b
(pass) mixed > c
(skip) mixed > d

 3 pass
 1 skip
 0 fail
 3 expect() calls
Ran 4 tests across 1 file. [12.00ms]
`;

describe("parseBunTestCounts", () => {
  it("parses the real one-test summary", () => {
    const counts = parseBunTestCounts(ONE_BLOB);
    expect(counts.parsed).toBe(true);
    expect(counts.passed).toBe(1);
    expect(counts.failed).toBe(0);
    expect(counts.executed).toBe(1);
    expect(counts.filesRan).toBe(1);
  });

  it("does not let the per-test (pass) line corrupt the counters", () => {
    const counts = parseBunTestCounts(ONE_BLOB);
    expect(counts.passed).toBe(1);
  });

  it("parses the real zero-test summary as executed 0", () => {
    const counts = parseBunTestCounts(ZERO_BLOB);
    expect(counts.parsed).toBe(true);
    expect(counts.passed).toBe(0);
    expect(counts.failed).toBe(0);
    expect(counts.executed).toBe(0);
  });

  it("counts skip-only as executed 0 despite Ran 1 test", () => {
    const counts = parseBunTestCounts(SKIP_BLOB);
    expect(counts.skipped).toBe(1);
    expect(counts.executed).toBe(0);
    expect(counts.parsed).toBe(true);
  });

  it("counts todo-only as executed 0 despite Ran 1 test", () => {
    const counts = parseBunTestCounts(TODO_BLOB);
    expect(counts.todo).toBe(1);
    expect(counts.executed).toBe(0);
    expect(counts.parsed).toBe(true);
  });

  it("does not count skipped tests as executed even though the Ran total includes them", () => {
    const counts = parseBunTestCounts(MIXED_BLOB);
    // Bun's `Ran` total includes skips, which is why `executed` derives from
    // `passed + failed` rather than the `Ran` line's total (D1).
    expect(counts.executed).toBe(3);
    expect(counts.passed).toBe(3);
    expect(counts.skipped).toBe(1);
    expect(counts.filesRan).toBe(1);
  });

  it("populates filesRan from the Ran line without affecting executed", () => {
    const counts = parseBunTestCounts(MIXED_BLOB);
    expect(counts.filesRan).toBe(1);
    expect(counts.executed).toBe(3);
  });

  it("defaults missing counters to zero", () => {
    const counts = parseBunTestCounts(ZERO_BLOB);
    expect(counts.skipped).toBe(0);
    expect(counts.todo).toBe(0);
  });

  it("ignores counter-like text inside test titles and diff output", () => {
    const blob = `bun test v1.3.13 (bf2e2cec)

(pass) suite > 1 fail path

  3 | expect(x).toBe(1)

 2 pass
 0 fail
Ran 2 tests across 1 file. [1.00ms]
`;
    const counts = parseBunTestCounts(blob);
    expect(counts.passed).toBe(2);
    expect(counts.failed).toBe(0);
  });

  it("sets parsed false on unrecognized output", () => {
    const counts = parseBunTestCounts("some arbitrary text with no summary lines\n");
    expect(counts.parsed).toBe(false);
    expect(counts.executed).toBe(0);
  });
});

describe("evaluateBunTestOutcome", () => {
  it("accepts the real one-test output", () => {
    const result = evaluateBunTestOutcome(ONE_BLOB, "one.test.ts");
    expect(result.ok).toBe(true);
  });

  it("accepts pass-with-skip", () => {
    const result = evaluateBunTestOutcome(MIXED_BLOB, "mixed.test.ts");
    expect(result.ok).toBe(true);
  });

  it("rejects the real skip-only output", () => {
    const result = evaluateBunTestOutcome(SKIP_BLOB, "skip.test.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe(
        'Structural assertion failed: test "skip.test.ts" executed zero tests (bun test reported no executed tests; an empty, skip-only, or todo-only test file cannot satisfy this assertion)',
      );
    }
  });

  it("fails closed on unparseable output", () => {
    const result = evaluateBunTestOutcome(
      "garbage output with nothing recognizable\n",
      "x.test.ts",
    );
    expect(result.ok).toBe(false);
  });
});
