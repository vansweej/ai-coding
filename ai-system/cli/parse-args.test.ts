import { describe, expect, it } from "bun:test";

import { DEFAULT_PROFILE_NAME } from "../config/model-profiles";
import { parseArgs } from "./parse-args";

describe("parseArgs", () => {
  it("returns error when no arguments provided", () => {
    const result = parseArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Missing pipeline name");
  });

  it("returns error when only pipeline name provided", () => {
    const result = parseArgs(["rust-plan-cycle"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Missing workspace path");
  });

  it("parses pipeline name and workspace", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pipelineName).toBe("rust-plan-cycle");
      expect(result.value.workspace).toBe("/tmp/ws");
      expect(result.value.input).toBe("");
    }
  });

  it("uses default profile when --profile is not provided", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.profileName).toBe(DEFAULT_PROFILE_NAME);
  });

  it("parses --input flag", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--input", "Add tests"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.input).toBe("Add tests");
  });

  it("parses --plan flag", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--plan", "plans/feature.md"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.planPath).toBe("plans/feature.md");
  });

  it("returns error when --plan flag has no value", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--plan"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--plan flag requires a value");
  });

  it("parses --max-retries flag", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--max-retries", "2"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.maxRetries).toBe(2);
  });

  it("returns error for invalid --max-retries value", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--max-retries", "nope"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--max-retries");
  });

  it("returns error when --input flag has no value", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--input"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--input flag requires a value");
  });

  it("returns error when --input value starts with --", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--input", "--other"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--input flag requires a value");
  });

  it("parses --profile flag", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--profile", "copilot-default"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.profileName).toBe("copilot-default");
  });

  it("returns error when --profile flag has no value", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--profile"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--profile flag requires a value");
  });

  it("returns error when --profile value starts with --", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--profile", "--other"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--profile flag requires a value");
  });

  it("parses both --input and --profile flags", () => {
    const result = parseArgs([
      "rust-plan-cycle",
      "/tmp/ws",
      "--profile",
      "copilot-default",
      "--input",
      "Add tests",
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.input).toBe("Add tests");
      expect(result.value.profileName).toBe("copilot-default");
    }
  });

  it("parses --language flag", () => {
    const result = parseArgs(["plan-cycle", "/tmp/ws", "--language", "typescript"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.language).toBe("typescript");
  });

  it("leaves language undefined when --language is not provided", () => {
    const result = parseArgs(["plan-cycle", "/tmp/ws"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.language).toBeUndefined();
  });

  it("returns error when --language flag has no value", () => {
    const result = parseArgs(["plan-cycle", "/tmp/ws", "--language"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--language flag requires a value");
  });

  it("defaults verbose to false when neither -v nor --verbose is provided", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.verbose).toBe(false);
  });

  it("sets verbose to true when --verbose is provided", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "--verbose"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.verbose).toBe(true);
  });

  it("sets verbose to true when -v is provided", () => {
    const result = parseArgs(["rust-plan-cycle", "/tmp/ws", "-v"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.verbose).toBe(true);
  });

  it("parses -v placed before a value flag without it being swallowed as the value", () => {
    const result = parseArgs(["plan-cycle", "/tmp/ws", "-v", "--plan", "p.md"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verbose).toBe(true);
      expect(result.value.planPath).toBe("p.md");
    }
  });
});
