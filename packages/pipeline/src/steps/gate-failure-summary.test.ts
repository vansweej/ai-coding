import { describe, expect, it } from "bun:test";

import { summarizeGateFailure } from "./gate-failure-summary";

describe("summarizeGateFailure", () => {
  it("summarizes a cargo test stdout block", () => {
    const summary = summarizeGateFailure(
      [
        "running 1 test",
        "---- parser::rejects_invalid_input stdout ----",
        "thread 'parser::rejects_invalid_input' panicked at src/parser.rs:42:5:",
        "invalid input",
        "",
        "failures:",
        "    parser::rejects_invalid_input",
      ].join("\n"),
      "error: test failed, to rerun pass --test parser",
    );

    expect(summary).toContain("panicked at src/parser.rs:42:5");
    expect(summary).not.toContain("failures:");
  });

  it("summarizes a rustc error with its location", () => {
    const summary = summarizeGateFailure(
      "",
      "error[E0433]: failed to resolve: use of undeclared crate\n --> src/main.rs:4:5",
    );

    expect(summary).toContain("error[E0433]");
    expect(summary).toContain("--> src/main.rs:4:5");
  });

  it("summarizes a clippy warning", () => {
    const summary = summarizeGateFailure("", "warning: this can be simplified");

    expect(summary).toBe("warning: this can be simplified");
  });

  it("summarizes a bun test failure", () => {
    const summary = summarizeGateFailure(
      "example test (fail)\nexpect(received).toBe(expected)",
      "",
    );

    expect(summary).toContain("example test (fail)");
    expect(summary).toContain("expect(received).toBe(expected)");
  });

  it("falls back to the first stderr lines", () => {
    const summary = summarizeGateFailure("", "\nfirst detail\n\nsecond detail\n");

    expect(summary).toBe("first detail\nsecond detail");
  });
});
