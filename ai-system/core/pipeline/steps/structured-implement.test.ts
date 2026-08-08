import { execSync } from "node:child_process";
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

/**
 * Initialize `workspace` as a git repository with a single seed commit
 * covering everything currently on disk. A freshly `git init`'d repo with
 * NO commits still passes `isGitRepo` (`git rev-parse --is-inside-work-tree`
 * only checks for a `.git` work tree, not a HEAD), but `git reset --hard
 * HEAD` THROWS when there is no HEAD to reset to. Every directory-git test
 * fixture MUST call this after seeding its files so HEAD exists and the
 * git-transactional restore path in `applyEditsTransactionally` behaves as
 * it does in real plan-cycle runs, where the pre-phase tree is always
 * committed.
 */
function initGitRepo(workspace: string): void {
  execSync("git init", { cwd: workspace, encoding: "utf8" });
  execSync('git config user.email "test@example.com"', { cwd: workspace, encoding: "utf8" });
  execSync('git config user.name "Test"', { cwd: workspace, encoding: "utf8" });
  execSync("git add -A", { cwd: workspace, encoding: "utf8" });
  execSync('git commit -m "seed"', { cwd: workspace, encoding: "utf8" });
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

  it("applies GREEN via create->edit coercion when the model emits a create op for an already-existing, non-empty file (Symptom B replay)", async () => {
    // Regression/replay test for the unified bug: a `create` op targeting a
    // file that already exists (e.g. relocated there by an earlier `move`)
    // used to decline with "already exists; cannot create" and fall back to
    // the flaky text loop. This canned ops payload -- not a live dispatch --
    // reproduces exactly that shape through the FULL tryStructuredPhase path,
    // proving coerceCreatesToEdits fires end to end (not only via hand-built
    // PatchEdits in coerce-create-to-edit.test.ts).
    writeFileSync(join(workspace, "crates_parlang_Cargo.toml"), "old manifest content");

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          {
            kind: "create",
            filePath: "crates_parlang_Cargo.toml",
            contents: "new manifest content",
          },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "crates_parlang_Cargo.toml"), "utf8")).toBe(
      "new manifest content",
    );
  });

  it("still creates a genuinely new file when the model emits a create op for a non-existent path", async () => {
    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "create", filePath: "brand-new.ts", contents: "export const z = 1;" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(workspace, "brand-new.ts"), "utf8")).toBe("export const z = 1;");
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

  it("rolls back a coerced create (file-only classification) to its pre-apply content when a later op fails", async () => {
    // The coerced edit here is the ONLY touched path with no directory
    // involved, so this exercises the FILE-ONLY (non-directory-touching)
    // branch of applyEditsTransactionally -- snapshotTouchedPaths /
    // rollbackToSnapshot -- proving rollback covers a create->edit coercion
    // in isolation, not just alongside a co-present move.
    writeFileSync(join(workspace, "manifest.toml"), "original manifest");

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          // Coerced to a whole-file-replace edit (manifest.toml already exists).
          { kind: "create", filePath: "manifest.toml", contents: "new manifest" },
          // Fails: anchor does not exist.
          { kind: "edit", filePath: "does-not-exist.ts", search: "y", replace: "z" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);

    expect(readFileSync(join(workspace, "manifest.toml"), "utf8")).toBe("original manifest");
  });

  it("rolls back a coerced create co-present with a directory move (git-transactional classification)", async () => {
    // The batch also contains a directory move, so touchesDirectory routes
    // the WHOLE batch (including the coerced create) through the
    // GIT-TRANSACTIONAL path (gitRestoreWorkingTree), not the file-only
    // snapshot path -- proving rollback covers a coerced create under BOTH
    // classifications.
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "lib.rs"), "pub fn lib() {}");
    writeFileSync(join(workspace, "manifest.toml"), "original manifest");

    initGitRepo(workspace);

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "move", filePath: "src", toPath: "crates/parlang/src" },
          // Coerced to a whole-file-replace edit (manifest.toml already exists).
          { kind: "create", filePath: "manifest.toml", contents: "new manifest" },
          // Fails: anchor does not exist.
          { kind: "edit", filePath: "does-not-exist.rs", search: "x", replace: "y" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);

    // Both the move and the coerced create must be reverted.
    expect(existsSync(join(workspace, "src"))).toBe(true);
    expect(readFileSync(join(workspace, "src", "lib.rs"), "utf8")).toBe("pub fn lib() {}");
    expect(existsSync(join(workspace, "crates"))).toBe(false);
    expect(readFileSync(join(workspace, "manifest.toml"), "utf8")).toBe("original manifest");
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
    //
    // This workspace is NOT a git repo, so it also documents the non-git
    // branch of the git-transactional directory routing added later:
    // directory-touching edits in a non-git workspace decline gracefully
    // with `directory-declined` rather than attempting a git-based apply.
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

  it("declines (err) without mutating when a directory move touches a non-git workspace", async () => {
    // Same non-git-decline outcome as the test above, but expressed as a
    // dedicated positive test for the graceful `directory-declined` branch
    // (rather than only the EISDIR-regression framing above), with an
    // explicit assertion on the decline message.
    mkdirSync(join(workspace, "plaindir"), { recursive: true });
    writeFileSync(join(workspace, "plaindir", "a.txt"), "hello");

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "move", filePath: "plaindir", toPath: "moved" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("directory-declined");
      expect(result.error.message).toContain("git");
    }

    expect(existsSync(join(workspace, "plaindir"))).toBe(true);
    expect(existsSync(join(workspace, "moved"))).toBe(false);
  });

  it("applies the full multi-directory move batch via the git-transactional path (parlang Phase-0 shape)", async () => {
    // Seeds the exact shape of the real parlang Phase-0 Step 1: whole
    // directories (src, tests, examples) plus a root Cargo.toml, all moved
    // under crates/parlang/. This is the apply-SUCCESS criterion, not merely
    // clean-restore-on-failure -- proves the structured path can carry a
    // real directory-reorg batch end to end.
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "lib.rs"), "pub fn lib() {}");
    mkdirSync(join(workspace, "tests"), { recursive: true });
    writeFileSync(join(workspace, "tests", "it.rs"), "// integration test");
    mkdirSync(join(workspace, "examples"), { recursive: true });
    writeFileSync(join(workspace, "examples", "demo.rs"), "fn main() {}");
    writeFileSync(join(workspace, "Cargo.toml"), '[package]\nname = "parlang"\n');

    initGitRepo(workspace);

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "move", filePath: "src", toPath: "crates/parlang/src" },
          { kind: "move", filePath: "tests", toPath: "crates/parlang/tests" },
          { kind: "move", filePath: "examples", toPath: "crates/parlang/examples" },
          { kind: "move", filePath: "Cargo.toml", toPath: "crates/parlang/Cargo.toml" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(true);

    expect(readFileSync(join(workspace, "crates/parlang/src/lib.rs"), "utf8")).toBe(
      "pub fn lib() {}",
    );
    expect(readFileSync(join(workspace, "crates/parlang/tests/it.rs"), "utf8")).toBe(
      "// integration test",
    );
    expect(readFileSync(join(workspace, "crates/parlang/examples/demo.rs"), "utf8")).toBe(
      "fn main() {}",
    );
    expect(readFileSync(join(workspace, "crates/parlang/Cargo.toml"), "utf8")).toBe(
      '[package]\nname = "parlang"\n',
    );

    expect(existsSync(join(workspace, "src"))).toBe(false);
    expect(existsSync(join(workspace, "tests"))).toBe(false);
    expect(existsSync(join(workspace, "examples"))).toBe(false);
    expect(existsSync(join(workspace, "Cargo.toml"))).toBe(false);
  });

  it("applies a mixed batch: directory move followed by a create under the new destination tree", async () => {
    // Proves mkdirSync(dirname) + renameSync handle nested directory moves,
    // and that op ORDER matters: applyPatch fails an `exists` check if a
    // move destination already exists, so the directory move must precede
    // any create/edit under it -- this is the order a model would emit.
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "lib.rs"), "pub fn lib() {}");

    initGitRepo(workspace);

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "move", filePath: "src", toPath: "crates/parlang/src" },
          {
            kind: "create",
            filePath: "crates/parlang/src/new_module.rs",
            contents: "pub fn new_module() {}",
          },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(true);

    expect(readFileSync(join(workspace, "crates/parlang/src/lib.rs"), "utf8")).toBe(
      "pub fn lib() {}",
    );
    expect(readFileSync(join(workspace, "crates/parlang/src/new_module.rs"), "utf8")).toBe(
      "pub fn new_module() {}",
    );
    expect(existsSync(join(workspace, "src"))).toBe(false);
  });

  it("restores the working tree via git when a directory-touching batch fails mid-apply", async () => {
    // First op is a valid directory move; second op fails (edit against a
    // non-existent anchor). Asserts the git-transactional restore
    // (gitRestoreWorkingTree) reverted the tree: the moved directory is back
    // at its original path with original contents, and the destination tree
    // is gone -- proving the text-loop fallback would start from a pristine
    // tree, not a half-applied one. The seed commit (via initGitRepo) is
    // mandatory here: without it, `git reset --hard HEAD` would throw
    // (no-HEAD hazard) instead of restoring cleanly.
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "lib.rs"), "pub fn lib() {}");

    initGitRepo(workspace);

    const config: OrchestratorConfig = {
      profile: CLAUDE_SONNET_PROFILE,
      dispatchers: {
        "claude-sonnet-5": structuredDispatcher([
          { kind: "move", filePath: "src", toPath: "crates/parlang/src" },
          { kind: "edit", filePath: "does-not-exist.rs", search: "x", replace: "y" },
        ]),
      },
    };

    const result = await tryStructuredPhase(makeEvent(), config, workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("apply-failed");
    }

    // Tree restored to the clean pre-apply committed state.
    expect(existsSync(join(workspace, "src"))).toBe(true);
    expect(readFileSync(join(workspace, "src", "lib.rs"), "utf8")).toBe("pub fn lib() {}");
    expect(existsSync(join(workspace, "crates"))).toBe(false);

    const status = execSync("git status --porcelain", { cwd: workspace, encoding: "utf8" });
    expect(status.trim()).toBe("");
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
