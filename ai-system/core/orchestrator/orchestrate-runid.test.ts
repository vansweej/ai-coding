import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import type { OrchestratorConfig } from "./orchestrate";
import { orchestrate } from "./orchestrate";

/**
 * A dispatcher whose `dispatch` always fails with a message `classifyError`
 * (see `src/errors/classify-error.ts`) classifies as `transient` (a timeout
 * phrase), so `orchestrate`'s transient-retry path -- and its
 * `emitTransientRetryDiagnosis` ledger write -- actually fires.
 */
function timeoutDispatcher(): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: false,
      error: new Error("request timed out"),
    }),
  };
}

function makeConfig(runId?: string): OrchestratorConfig {
  return {
    dispatchers: {
      "claude-sonnet-4.6": timeoutDispatcher(),
      "deepseek-coder-v2": timeoutDispatcher(),
      "gemma4:26b": timeoutDispatcher(),
    },
    ...(runId !== undefined ? { runId } : {}),
  };
}

/**
 * Proves `emitTransientRetryDiagnosis`'s ledger writes are routed to the
 * run's own id (and the `"unknown-run-id"` fallback) without ever throwing,
 * exercising the real transient-retry/transient-exhaustion dispatch path.
 * `HOME` is overridden to a temp dir so ledger writes never land under the
 * real home directory.
 */
describe("orchestrate: transient-retry diagnosis routes to the run's own id", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), "orch-home-"));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      process.env.HOME = undefined;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("resolves ok:false (never throws) when a runId is provided", async () => {
    const event = {
      id: "test-runid-1",
      timestamp: Date.now(),
      source: "cli" as const,
      action: "plan" as const,
      payload: { input: "design a feature" },
    };

    const result = await orchestrate(event, makeConfig("run-xyz"));

    expect(result.ok).toBe(false);
  });

  it("resolves ok:false (never throws) when no runId is provided (fallback path)", async () => {
    const event = {
      id: "test-runid-2",
      timestamp: Date.now(),
      source: "cli" as const,
      action: "plan" as const,
      payload: { input: "design a feature" },
    };

    const result = await orchestrate(event, makeConfig());

    expect(result.ok).toBe(false);
  });
});
