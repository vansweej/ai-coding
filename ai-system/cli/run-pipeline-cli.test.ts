import { describe, expect, it } from "bun:test";

import { getUsage, parseArgs } from "./parse-args";
import { TEST_FILE_BACKEND, selectPipeline } from "./select-pipeline";

// ─── parseArgs ────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("parses pipeline name and workspace", () => {
    const result = parseArgs(["scaffold-rust", "/tmp/my-project"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.pipelineName).toBe("scaffold-rust");
      expect(result.value.workspace).toBe("/tmp/my-project");
      expect(result.value.input).toBe("");
    }
  });

  it("parses --input flag value", () => {
    const result = parseArgs(["dev-cycle", "./proj", "--input", "Add error handling"]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.input).toBe("Add error handling");
    }
  });

  it("fails when pipeline name is missing", () => {
    const result = parseArgs([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Missing pipeline name");
    }
  });

  it("fails when workspace is missing", () => {
    const result = parseArgs(["scaffold-rust"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Missing workspace path");
    }
  });

  it("fails when --input flag has no value", () => {
    const result = parseArgs(["dev-cycle", "./proj", "--input"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("--input flag requires a value");
    }
  });

  it("fails when --input value looks like another flag", () => {
    const result = parseArgs(["dev-cycle", "./proj", "--input", "--other"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("--input flag requires a value");
    }
  });

  it("getUsage returns a non-empty string containing pipeline names", () => {
    const usage = getUsage();
    expect(usage.length).toBeGreaterThan(0);
    expect(usage).toContain("scaffold-rust");
    expect(usage).toContain("scaffold-cpp");
  });
});

// ─── selectPipeline ───────────────────────────────────────────────────────────

const STUB_CONFIG = { dispatchers: {} };

describe("selectPipeline", () => {
  it("selects dev-cycle", async () => {
    const result = await selectPipeline("dev-cycle", STUB_CONFIG, "/tmp/ws", TEST_FILE_BACKEND);
    expect(result.ok).toBe(true);
  });

  it("selects rust-dev-cycle", async () => {
    const result = await selectPipeline(
      "rust-dev-cycle",
      STUB_CONFIG,
      "/tmp/ws",
      TEST_FILE_BACKEND,
    );
    expect(result.ok).toBe(true);
  });

  it("selects cmake-dev-cycle", async () => {
    const result = await selectPipeline(
      "cmake-dev-cycle",
      STUB_CONFIG,
      "/tmp/ws",
      TEST_FILE_BACKEND,
    );
    expect(result.ok).toBe(true);
  });

  it("selects scaffold-rust", async () => {
    const result = await selectPipeline("scaffold-rust", STUB_CONFIG, "/tmp/ws", TEST_FILE_BACKEND);
    expect(result.ok).toBe(true);
  });

  it("selects scaffold-cpp", async () => {
    const result = await selectPipeline("scaffold-cpp", STUB_CONFIG, "/tmp/ws", TEST_FILE_BACKEND);
    expect(result.ok).toBe(true);
  });

  it("fails for an unknown pipeline name", async () => {
    const result = await selectPipeline(
      "not-a-pipeline",
      STUB_CONFIG,
      "/tmp/ws",
      TEST_FILE_BACKEND,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unknown pipeline");
      expect(result.error.message).toContain('"not-a-pipeline"');
    }
  });

  it("returns a non-empty step array for each known pipeline", async () => {
    const names = [
      "dev-cycle",
      "rust-dev-cycle",
      "cmake-dev-cycle",
      "scaffold-rust",
      "scaffold-cpp",
    ];
    for (const name of names) {
      const result = await selectPipeline(name, STUB_CONFIG, "/tmp/ws", TEST_FILE_BACKEND);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeGreaterThan(0);
      }
    }
  });
});
