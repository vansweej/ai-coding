import { describe, expect, it } from "bun:test";

import { buildVerificationFailurePrompt } from "../pipeline/steps/verified-implement-step";

/**
 * Regression guard for the patch-parse diagnostic path.
 *
 * `buildVerificationFailurePrompt` is used to construct the retry prompt
 * that includes a `boundedPayload` of context (original instruction,
 * previously written code, current file contents, verification error).
 * These tests assert that the function produces a bounded, structured
 * payload containing the expected sections.
 */
describe("buildVerificationFailurePrompt (boundedPayload)", () => {
  it("includes the original instruction in the output", () => {
    const prompt = buildVerificationFailurePrompt("do the thing", "code here", "error here");
    expect(prompt).toContain("do the thing");
  });

  it("includes the previously written code in the output", () => {
    const prompt = buildVerificationFailurePrompt("instruction", "prev code", "error");
    expect(prompt).toContain("prev code");
  });

  it("includes the verification error in the output", () => {
    const prompt = buildVerificationFailurePrompt("instruction", "code", "compile error xyz");
    expect(prompt).toContain("compile error xyz");
  });

  it("includes current file contents when provided (boundedPayload)", () => {
    const prompt = buildVerificationFailurePrompt(
      "instruction",
      "code",
      "error",
      "// current file\nexport const x = 1;",
    );
    expect(prompt).toContain("// current file");
    expect(prompt).toContain("export const x = 1;");
  });

  it("omits file contents section when not provided (boundedPayload)", () => {
    const prompt = buildVerificationFailurePrompt("instruction", "code", "error");
    expect(prompt).not.toContain("Current file contents:");
  });

  it("always includes Fix the implementation so verification passes header", () => {
    const prompt = buildVerificationFailurePrompt("i", "c", "e");
    expect(prompt).toContain("Fix the implementation so verification passes.");
  });

  it("always includes SEARCH/REPLACE patch format instruction (boundedPayload)", () => {
    const prompt = buildVerificationFailurePrompt("i", "c", "e");
    expect(prompt).toContain("SEARCH/REPLACE");
  });
});
