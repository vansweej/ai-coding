import { describe, expect, it } from "bun:test";

import { reportFeatureFailure } from "../../ai-system/cli/run-pipeline-cli";
import {
  DevShellPaletteError,
  MappedToolchainUnavailableError,
} from "../../ai-system/core/pipeline/feature-runner";
import { BaselineCheckError } from "../../ai-system/core/pipeline/phase-runner";

describe("MappedToolchainUnavailableError", () => {
  it("has name 'MappedToolchainUnavailableError' and is an instanceof Error", () => {
    const error = new MappedToolchainUnavailableError("x");
    expect(error.name).toBe("MappedToolchainUnavailableError");
    expect(error).toBeInstanceOf(Error);
  });

  it("reportFeatureFailure maps it to exitCode 3 (ENVIRONMENT_ERROR)", () => {
    const { exitCode } = reportFeatureFailure(new MappedToolchainUnavailableError("x"), false);
    expect(exitCode).toBe(3);
  });

  it("reportFeatureFailure still maps a plain Error to exitCode 2 (RESUMABLE_FAILURE)", () => {
    const { exitCode } = reportFeatureFailure(new Error("x"), false);
    expect(exitCode).toBe(2);
  });

  it("reportFeatureFailure still maps DevShellPaletteError and BaselineCheckError to exitCode 3", () => {
    expect(reportFeatureFailure(new DevShellPaletteError("x"), false).exitCode).toBe(3);
    expect(reportFeatureFailure(new BaselineCheckError("x"), false).exitCode).toBe(3);
  });
});
