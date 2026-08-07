import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type {
  AIRequestEvent,
  DispatchRequest,
  ModelDispatcher,
  PatchOp,
  Result,
} from "@ai-coding/shared";

import type { ModelProfile } from "../../../config/model-profiles";
import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import { tryStructuredPhase } from "./structured-implement";

function makeEvent(action: AIRequestEvent["action"] = "edit"): AIRequestEvent {
  return {
    id: "test",
    timestamp: Date.now(),
    source: "cli",
    action,
    payload: { input: "implement the thing" },
  };
}

const CLAUDE_SONNET_PROFILE: ModelProfile = {
  name: "anthropic-sonnet",
  roles: {
    planner: "claude-sonnet-5",
    implementer: "claude-sonnet-5",
    debugger: "claude-sonnet-5",
    fixer: "claude-sonnet-5",
    reviewer: "claude-sonnet-5",
    tester: "claude-sonnet-5",
    scaffolder: "claude-sonnet-5",
    explorer: "claude-sonnet-5",
    default: "claude-sonnet-5",
  },
};

function textOnlyDispatcher(): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "text-response",
    }),
  };
}

function structuredDispatcher(ops: readonly PatchOp[]): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "unused",
    }),
    dispatchPatch: async (_req: DispatchRequest): Promise<Result<readonly PatchOp[]>> => ({
      ok: true,
      value: ops,
    }),
  };
}

function failingStructuredDispatcher(message: string): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "unused",
    }),
    dispatchPatch: async (_req: DispatchRequest): Promise<Result<readonly PatchOp[]>> => ({
      ok: false,
      error: new Error(message),
    }),
  };
}

function throwingStructuredDispatcher(): ModelDispatcher {
  return {
    dispatch: async (_req: DispatchRequest): Promise<Result<string>> => ({
      ok: true,
      value: "unused",
    }),
    dispatchPatch: async (_req: DispatchRequest): Promise<Result<readonly PatchOp[]>> => {
      throw new Error("boom");
    },
  };
}

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "structured-implement-test-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("tryStructuredPhase", () => {
  it("falls back (err) when the resolved model is not structured-capable", async () => {
    const config: OrchestratorConfig = {
      dispatchers: { "gemma4:26b": structuredDispatcher([]) },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("not-capable-text-mode");
    }
  });

  it("falls back (err) when the dispatcher lacks dispatchPatch", async () => {
    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: { "claude-sonnet-5": textOnlyDispatcher() },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("not-capable-no-dispatch-patch");
    }
  });

  it("falls back (err) when dispatchPatch itself fails", async () => {
    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: { "claude-sonnet-5": failingStructuredDispatcher("truncated tool call") },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("dispatch-error");
      expect(result.error.message).toContain("truncated tool call");
    }
  });

  it("falls back (err) when ops fail patchOpsToEdits conversion", async () => {
    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "edit", filePath: "a.ts", search: "", replace: "y" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("conversion-failed");
    }
  });

  it("applies a valid whole-phase create op to the workspace", async () => {
    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "create", filePath: "src/new.ts", contents: "export const x = 1;" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "src/new.ts"), "utf8")).toBe("export const x = 1;");
  });

  it("applies a multi-op whole-phase patch atomically", async () => {
    writeFileSync(join(workspace, "existing.ts"), "export const a = 1;");

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "create", filePath: "src/new.ts", contents: "export const b = 2;" },
          { kind: "edit", filePath: "existing.ts", search: "a = 1", replace: "a = 2" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "src/new.ts"), "utf8")).toBe("export const b = 2;");
    expect(readFileSync(join(workspace, "existing.ts"), "utf8")).toBe("export const a = 2;");
  });

  it("rolls back a partially-applied patch when a later op fails (no half-applied tree)", async () => {
    writeFileSync(join(workspace, "existing.ts"), "export const a = 1;");

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          // op 1: succeeds, creates a brand-new file
          { kind: "create", filePath: "src/new.ts", contents: "export const b = 2;" },
          // op 2: succeeds, edits an existing file
          { kind: "edit", filePath: "existing.ts", search: "a = 1", replace: "a = 2" },
          // op 3: fails -- anchor does not exist anymore (already replaced)
          { kind: "edit", filePath: "existing.ts", search: "a = 1", replace: "a = 3" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);

    // op 1's created file must be rolled back (deleted) -- no half-applied tree.
    expect(existsSync(join(workspace, "src/new.ts"))).toBe(false);
    // op 2's edit must be rolled back to its pre-attempt content.
    expect(readFileSync(join(workspace, "existing.ts"), "utf8")).toBe("export const a = 1;");
  });

  it("rolls back a partial move when a later op fails", async () => {
    writeFileSync(join(workspace, "old.ts"), "export const x = 1;");

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "move", filePath: "old.ts", toPath: "new.ts" },
          { kind: "edit", filePath: "does-not-exist.ts", search: "y", replace: "z" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);

    // The move must be reversed: old.ts restored, new.ts removed.
    expect(existsSync(join(workspace, "old.ts"))).toBe(true);
    expect(readFileSync(join(workspace, "old.ts"), "utf8")).toBe("export const x = 1;");
    expect(existsSync(join(workspace, "new.ts"))).toBe(false);
  });

  it("declines (err) without throwing or mutating when a move touches a directory", async () => {
    // Regression guard: against the UNPATCHED code, snapshotTouchedPaths did
    // an unconditional `readFileSync` on every touched path, which throws
    // `EISDIR: illegal operation on a directory, read` when the path is an
    // existing directory (legitimate for a move op, since the applier moves
    // via `renameSync`, which supports directories). That throw escaped
    // `tryStructuredPhase`'s never-throws contract and crashed the whole
    // plan-cycle pipeline. This test is the regression guard for the
    // directory-decline fix. Post-fix, this must resolve (not reject) with a
    // clean error Result and leave the workspace untouched.
    mkdirSync(join(workspace, "somedir"), { recursive: true });

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "move", filePath: "somedir", toPath: "dest" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("directory-declined");
    }

    expect(existsSync(join(workspace, "somedir"))).toBe(true);
    expect(lstatSync(join(workspace, "somedir")).isDirectory()).toBe(true);
    expect(existsSync(join(workspace, "dest"))).toBe(false);
  });

  it("attributes apply-failed when an edit anchor does not match", async () => {
    writeFileSync(join(workspace, "existing.ts"), "export const a = 1;");

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "edit", filePath: "existing.ts", search: "a = 999", replace: "a = 2" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("apply-failed");
    }
  });

  it("never throws when the dispatcher rejects (honors the never-throws contract)", async () => {
    // The only test that reaches tryStructuredPhase's top-level catch: a
    // rejecting dispatchPatch is a real, reachable production path -- it
    // propagates through orchestratePatch (which does not itself guard
    // against a throwing dispatcher) and must be converted into an error
    // Result rather than crashing the pipeline.
    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": throwingStructuredDispatcher(),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("threw");
    }
  });
});
