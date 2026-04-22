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
    const result = parseArgs(["dev-cycle"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Missing workspace path");
  });

  it("parses pipeline name and workspace", () => {
    const result = parseArgs(["dev-cycle", "/tmp/ws"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pipelineName).toBe("dev-cycle");
      expect(result.value.workspace).toBe("/tmp/ws");
      expect(result.value.input).toBe("");
    }
  });

  it("uses default profile when --profile is not provided", () => {
    const result = parseArgs(["dev-cycle", "/tmp/ws"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.profileName).toBe(DEFAULT_PROFILE_NAME);
  });

  it("parses --input flag", () => {
    const result = parseArgs(["dev-cycle", "/tmp/ws", "--input", "Add tests"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.input).toBe("Add tests");
  });

  it("returns error when --input flag has no value", () => {
    const result = parseArgs(["dev-cycle", "/tmp/ws", "--input"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--input flag requires a value");
  });

  it("returns error when --input value starts with --", () => {
    const result = parseArgs(["dev-cycle", "/tmp/ws", "--input", "--other"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--input flag requires a value");
  });

  it("parses --profile flag", () => {
    const result = parseArgs(["dev-cycle", "/tmp/ws", "--profile", "copilot-default"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.profileName).toBe("copilot-default");
  });

  it("returns error when --profile flag has no value", () => {
    const result = parseArgs(["dev-cycle", "/tmp/ws", "--profile"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--profile flag requires a value");
  });

  it("returns error when --profile value starts with --", () => {
    const result = parseArgs(["dev-cycle", "/tmp/ws", "--profile", "--other"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("--profile flag requires a value");
  });

  it("parses both --input and --profile flags", () => {
    const result = parseArgs([
      "dev-cycle",
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
});
