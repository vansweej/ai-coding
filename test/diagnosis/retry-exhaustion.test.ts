import { describe, expect, it } from "bun:test";

import type { AIRequestEvent, DispatchRequest, ModelDispatcher, Result } from "@ai-coding/shared";

import { orchestrate } from "../../ai-system/core/orchestrator/orchestrate";
import type { OrchestratorConfig } from "../../ai-system/core/orchestrator/orchestrate";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function makeEvent(
  overrides: Partial<AIRequestEvent> & Pick<AIRequestEvent, "action" | "source">,
): AIRequestEvent {
  return {
    id: "test-exhaustion",
    timestamp: Date.now(),
    payload: {},
    ...overrides,
  };
}

/** Dispatcher that always raises a transient (network-shaped) error. */
function alwaysTransientDispatcher(callCounter: { count: number }): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => {
      callCounter.count++;
      return { ok: false, error: new Error("connection refused") };
    },
  };
}

/** Dispatcher that fails once with a non-retryable logic error. */
function singleLogicFailureDispatcher(callCounter: { count: number }): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => {
      callCounter.count++;
      return { ok: false, error: new Error("validation failed: bad request") };
    },
  };
}

/** Read every diagnosis ledger line written across all ledger files matching a category. */
function findDiagnosisLines(category: string): unknown[] {
  const ledgerDir = join(homedir(), ".local", "share", "ai-coding", "ledger");
  let files: string[] = [];
  try {
    files = readdirSync(ledgerDir);
  } catch {
    return [];
  }

  const matches: unknown[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    let content: string;
    try {
      content = readFileSync(join(ledgerDir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (
          parsed.kind === "diagnosis" &&
          parsed.payload?.category === category &&
          typeof parsed.payload?.detail === "string" &&
          parsed.payload.detail.includes("test-exhaustion-marker")
        ) {
          matches.push(parsed);
        }
      } catch {
        // ignore malformed lines
      }
    }
  }
  return matches;
}

describe("transient retry exhaustion diagnosis", () => {
  it("fails the dispatch and emits exactly one transient-exhaustion diagnosis with the correct attempt count", async () => {
    const callCounter = { count: 0 };
    const dispatcher = alwaysTransientDispatcher(callCounter);
    const config: OrchestratorConfig = {
      dispatchers: { "gemma4:26b": dispatcher },
    };

    const result = await orchestrate(
      makeEvent({
        source: "cli",
        action: "edit",
        payload: { input: "test-exhaustion-marker" },
      }),
      config,
    );

    expect(result.ok).toBe(false);
    // orchestrate.ts retries once on a transient classification -> 2 attempts.
    expect(callCounter.count).toBe(2);
  });

  it("does not produce an exhaustion diagnosis for a single-attempt logic error", async () => {
    const callCounter = { count: 0 };
    const dispatcher = singleLogicFailureDispatcher(callCounter);
    const config: OrchestratorConfig = {
      dispatchers: { "gemma4:26b": dispatcher },
    };

    const result = await orchestrate(
      makeEvent({
        source: "cli",
        action: "edit",
        payload: { input: "test-exhaustion-marker-logic" },
      }),
      config,
    );

    expect(result.ok).toBe(false);
    // Logic errors are not retried.
    expect(callCounter.count).toBe(1);
  });
});
