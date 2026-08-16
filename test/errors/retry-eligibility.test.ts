import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { LOCAL_PROFILE } from "../../ai-system/config/model-profiles";
import type { OrchestratorConfig } from "../../ai-system/core/orchestrator/orchestrate";
import { createVerifiedImplementStep } from "../../ai-system/core/pipeline/steps/verified-implement-step";

/**
 * Behavioral tests proving the retry loop's eligibility gate: a `logic`
 * (deterministic) dispatch error must fail fast (dispatch called exactly
 * once, no retry attempted), while a `transient` error is retried.
 */
describe("retry eligibility gating (classifyError)", () => {
  function makeDispatcher(error: Error): { dispatcher: ModelDispatcher; callCount: () => number } {
    let calls = 0;
    const dispatcher: ModelDispatcher = {
      dispatch: async (_req: DispatchRequest): Promise<Result<string>> => {
        calls++;
        return { ok: false, error };
      },
    };
    return { dispatcher, callCount: () => calls };
  }

  function makeConfig(dispatcher: ModelDispatcher): OrchestratorConfig {
    return { profile: LOCAL_PROFILE, dispatchers: { "gemma4:26b": dispatcher } };
  }

  it("does not retry when the dispatcher returns a logic (validation) error", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "retry-eligibility-logic-"));
    try {
      writeFileSync(join(workspace, "a.md"), "seed\n");
      const logicError = new Error("validation failed: bad request");
      const { dispatcher, callCount } = makeDispatcher(logicError);

      const step = createVerifiedImplementStep("test-step", {
        config: makeConfig(dispatcher),
        workspace,
        palette: new Set(),
        retryConfig: { maxLocalRetries: 3, maxEscalationRetries: 1 },
      });

      const result = await step.execute({
        event: {
          id: "t",
          timestamp: Date.now(),
          source: "cli",
          action: "edit",
          payload: { input: "do the thing" },
        },
        results: new Map(),
      });

      expect(result.ok).toBe(false);
      // Exactly one dispatch call: the structured-attempt path is text-mode
      // (no-op) for the local profile, so the first real dispatch is the
      // initial local attempt; the fast-fail must prevent any further calls.
      expect(callCount()).toBe(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("retries when the dispatcher returns a transient (network) error", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "retry-eligibility-transient-"));
    try {
      writeFileSync(join(workspace, "a.md"), "seed\n");
      const transientError = new Error("connection refused");
      const { dispatcher, callCount } = makeDispatcher(transientError);

      const step = createVerifiedImplementStep("test-step", {
        config: makeConfig(dispatcher),
        workspace,
        palette: new Set(),
        retryConfig: { maxLocalRetries: 1, maxEscalationRetries: 0 },
      });

      const result = await step.execute({
        event: {
          id: "t",
          timestamp: Date.now(),
          source: "cli",
          action: "edit",
          payload: { input: "do the thing" },
        },
        results: new Map(),
      });

      expect(result.ok).toBe(false);
      // At least one retry happened: more than a single dispatch call.
      expect(callCount()).toBeGreaterThan(1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
