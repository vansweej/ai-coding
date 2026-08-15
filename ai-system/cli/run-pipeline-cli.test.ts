import { describe, expect, it } from "bun:test";

import { DevShellPaletteError } from "../core/pipeline/feature-runner";
import { BaselineCheckError } from "../core/pipeline/phase-runner";
import { getUsage, parseArgs } from "./parse-args";
import { reportFeatureFailure } from "./run-pipeline-cli";
import { selectPipeline } from "./select-pipeline";

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
    const result = parseArgs(["plan-cycle", "./proj", "--input", "Add error handling"]);
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
    const result = parseArgs(["plan-cycle", "./proj", "--input"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("--input flag requires a value");
    }
  });

  it("fails when --input value looks like another flag", () => {
    const result = parseArgs(["plan-cycle", "./proj", "--input", "--other"]);
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

// ─── reportFeatureFailure ─────────────────────────────────────────────────────

describe("reportFeatureFailure", () => {
  const errorCases: ReadonlyArray<{ readonly label: string; readonly error: Error }> = [
    { label: "plain Error", error: new Error("plain failure") },
    { label: "DevShellPaletteError", error: new DevShellPaletteError("devshell broken") },
    { label: "BaselineCheckError", error: new BaselineCheckError("baseline broken") },
    { label: "parse error", error: new Error("Failed to parse patches: bad input") },
  ];

  for (const { label, error } of errorCases) {
    it(`produces a non-null/non-empty message for ${label} with verbose=true`, () => {
      const { message } = reportFeatureFailure(error, true);
      expect(message).not.toBeNull();
      expect(message.length).toBeGreaterThan(0);
    });

    it(`produces a non-null/non-empty message for ${label} with verbose=false`, () => {
      const { message } = reportFeatureFailure(error, false);
      expect(message).not.toBeNull();
      expect(message.length).toBeGreaterThan(0);
    });
  }

  it("yields exitCode 3 (ENVIRONMENT_ERROR) for a DevShellPaletteError", () => {
    const { exitCode } = reportFeatureFailure(new DevShellPaletteError("bad devshell"), false);
    expect(exitCode).toBe(3);
  });

  it("yields exitCode 3 (ENVIRONMENT_ERROR) for a BaselineCheckError", () => {
    const { exitCode } = reportFeatureFailure(new BaselineCheckError("bad baseline"), false);
    expect(exitCode).toBe(3);
  });

  it("yields exitCode 2 (RESUMABLE_FAILURE) for a plain/parse error", () => {
    const { exitCode } = reportFeatureFailure(new Error("some plain failure"), false);
    expect(exitCode).toBe(2);
  });
});

// ─── selectPipeline ───────────────────────────────────────────────────────────

const STUB_CONFIG = { dispatchers: {} };

describe("selectPipeline", () => {
  it("selects scaffold-rust", async () => {
    const result = await selectPipeline("scaffold-rust", STUB_CONFIG, "/tmp/ws");
    expect(result.ok).toBe(true);
  });

  it("selects scaffold-cpp", async () => {
    const result = await selectPipeline("scaffold-cpp", STUB_CONFIG, "/tmp/ws");
    expect(result.ok).toBe(true);
  });

  it("fails for an unknown pipeline name", async () => {
    const result = await selectPipeline("not-a-pipeline", STUB_CONFIG, "/tmp/ws");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unknown pipeline");
      expect(result.error.message).toContain('"not-a-pipeline"');
    }
  });

  it("returns a non-empty step array for each known pipeline", async () => {
    const names = ["doc-cycle", "scaffold-rust", "scaffold-cpp"];
    for (const name of names) {
      const result = await selectPipeline(name, STUB_CONFIG, "/tmp/ws");
      if (name === "doc-cycle") {
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok).toBe(true);
      }
      if (result.ok) {
        expect(result.value.length).toBeGreaterThan(0);
      }
    }
  });
});
