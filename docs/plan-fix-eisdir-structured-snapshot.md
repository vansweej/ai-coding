# Feature: Fix EISDIR crash in structured-implement snapshot (decline directory-touching edits cleanly + enforce never-throws contract)

> **SUPERSEDED (see `docs/plan-structured-directory-moves.md`):** the scope-limiting
> statements in this plan that describe directory-touching structured edits as
> permanently "declined" / "out of scope" / "not valid pipeline-plan operations" have
> been REVERSED. Directory-touching structured edits are now applied
> transactionally via a git-based restore (`git reset --hard HEAD` + `git clean -fd`)
> when `workspace` is a git repository -- see `applyEditsTransactionally` in
> `ai-system/core/pipeline/steps/structured-implement.ts` and the routing description
> in `docs/architecture.md`. They decline gracefully with `directory-declined` ONLY
> when the workspace is NOT a git repository (this original EISDIR-avoidance guard in
> `snapshotTouchedPaths` remains as a defensive backstop on the file-only path). The
> historical rationale below (directory moves cannot be transactionally
> snapshotted/rolled back via the file-content model) is still accurate -- it is
> exactly why directory-touching edits were split onto a separate git-transactional
> path rather than being forced through that model.

## Phase 1: Snapshot declines directory-touching edits

Commit message: `fix: decline structured patch snapshot for directory-touching paths`

### Step 1: Return Result from snapshotTouchedPaths and refuse directory paths

In `ai-system/core/pipeline/steps/structured-implement.ts`:

- Add `lstatSync` to the existing `node:fs` import (alongside `existsSync`, `readFileSync`, and whatever else is already imported from `node:fs`).
- Change the return type of the module-private `snapshotTouchedPaths` function from `PathSnapshot[]` to `Result<PathSnapshot[]>` (`Result` is imported from `@ai-coding/shared`; shape is `{ok:true;value:T}|{ok:false;error:Error}`).
- For each touched path, compute `absPath` as it does today and `const existed = existsSync(absPath)`. Then:
  - If `existed && lstatSync(absPath).isDirectory()`: immediately `return { ok: false, error: new Error(\`Refusing structured patch: touched path "${touchedPath}" is a directory, which cannot be transactionally snapshotted/rolled back\`) }` — do NOT read the path, do NOT push a snapshot, and do this BEFORE any `applyPatch` mutation occurs.
  - Else if `existed`: read the file with `readFileSync(absPath, "utf8")` and push `{ existed: true, content }` (preserve the exact existing snapshot shape/field names).
  - Else (`!existed`): push `{ existed: false, content: undefined }` (preserve existing shape).
- After the loop, `return { ok: true, value: snapshots }`.
- Do NOT change the `PathSnapshot` type or the `rollbackToSnapshot` function.
- Update the doc comment on `snapshotTouchedPaths` to state that it now returns a `Result`, and that it refuses (returns an error `Result`) when any touched path is an existing directory, because directory moves cannot be faithfully snapshotted or rolled back. Note the refusal happens before any mutation.

### Step 2: Propagate the snapshot Result in applyEditsTransactionally

In `ai-system/core/pipeline/steps/structured-implement.ts`, in `applyEditsTransactionally` (the sole caller of `snapshotTouchedPaths`, at the call site around line 91):

- Capture the returned `Result`: `const snapshotResult = snapshotTouchedPaths(...)`.
- If `!snapshotResult.ok`, `return snapshotResult` directly (nothing has been applied yet, so no rollback is needed). Since the function's own return type is a `Result` of the same error type, this propagates cleanly.
- Otherwise bind `const snapshots = snapshotResult.value;` and continue the rest of the function body exactly as before (apply/rollback logic unchanged).
- Update the doc comment on `applyEditsTransactionally` to note that it returns early with an error `Result` (no mutation, no rollback) when snapshotting refuses a directory-touching path.

## Phase 2: Guarantee tryStructuredPhase never throws

Commit message: `fix: wrap tryStructuredPhase body so it never throws`

### Step 1: Add belt-and-suspenders try/catch around the tryStructuredPhase body

In `ai-system/core/pipeline/steps/structured-implement.ts`, in `tryStructuredPhase`:

- Wrap the entire body — from the `orchestratePatch(...)` call through the final `return { ok: true, value: "applied" }` — in a single `try` block.
- Add a matching `catch (error)` that returns `{ ok: false, error: error instanceof Error ? error : new Error(String(error)) }`.
- Do NOT alter any of the existing branch/return logic inside the `try`; only enclose it.
- The motivating real production path: `orchestratePatch` awaits `dispatcher.dispatchPatch(...)` (orchestrate.ts:216) with no try/catch, so a rejecting `dispatchPatch` propagates out of `orchestratePatch` and would otherwise escape `tryStructuredPhase`. This catch upholds the contract that `tryStructuredPhase` never throws, so its caller (`verified-implement-step.ts:546`) can always fall back to the aider-text loop.
- Extend the `tryStructuredPhase` doc comment to state explicitly that it never throws: any thrown error (including a rejected `dispatchPatch`) is converted into an error `Result` so the caller can fall back to the text loop.
- Do NOT modify `verified-implement-step.ts`.

## Phase 3: Tests

Commit message: `test: cover directory-decline and never-throws contract in structured-implement`

### Step 1: Keep the EISDIR directory-move regression test

In the structured-implement test file (`ai-system/core/pipeline/steps/structured-implement.test.ts`, or the existing colocated test for this module):

- Ensure `mkdirSync` and `lstatSync` are imported from `node:fs` in the test file (add them if missing).
- Add/keep a test titled `"declines (err) without throwing or mutating when a move touches a directory"`:
  - Seed a directory: `mkdirSync(join(workspace, "somedir"), { recursive: true })`.
  - Build the fake dispatcher via `structuredDispatcher([{ kind: "move", filePath: "somedir", toPath: "dest" }])` (the fake returns the ops directly through `dispatchPatch`, bypassing parsing, so the ops must be valid `PatchOp`s — `move` uses `filePath`/`toPath`).
  - `await` the `tryStructuredPhase` call directly and assert it does NOT reject.
  - Assert `result.ok === false`.
  - Assert `somedir` still exists and `lstatSync(join(workspace, "somedir")).isDirectory()` is `true`, and that `dest` does NOT exist (no mutation occurred).
  - In the test's intent comment, state that against the UNPATCHED code this would reject with `EISDIR` (the old unconditional `readFileSync` on a directory), so this test is the regression guard for the directory-decline fix.

### Step 2: Add a never-throws test that reaches the Phase 2 catch block

In the same test file:

- REMOVE the old "create onto directory" test — it duplicated Step 1's snapshot-decline branch and its title falsely implied it exercised the catch block.
- Add a new test titled `"never throws when the dispatcher rejects (honors the never-throws contract)"`:
  - Define a throwing dispatcher (a dedicated `throwingStructuredDispatcher` helper or an inline object) exposing `dispatchPatch: async () => { throw new Error("boom"); }`, shaped to satisfy the `ModelDispatcher` surface `tryStructuredPhase`/`orchestratePatch` expects.
  - Drive `tryStructuredPhase` with it and `await` directly; assert the promise does NOT reject and that `result.ok === false`.
  - This is the only test that reaches the Phase 2 catch, and it models a real production path (a rejecting `dispatchPatch` propagating through `orchestratePatch`).
- Do NOT use a `v8-ignore` pragma on the catch block — this test provides real coverage for it.
- Remove any imports left unused by deleting the old test, so the Biome gate stays green.

## Phase 4: Documentation

Commit message: `docs: note directory-decline and never-throws behavior for structured patch`

### Step 1: Update architecture docs for structured-patch / plan-cycle

In `docs/architecture.md`, in the structured-patch / plan-cycle section:

- Document that directory-touching structured edits now decline cleanly to the aider-text fallback rather than crashing (directory moves cannot be transactionally snapshotted or rolled back, and per operating rule are not valid pipeline-plan operations anyway).
- Document that `tryStructuredPhase` honors a never-throws contract: any thrown error — including a rejected `dispatchPatch` from `orchestratePatch` — is converted into an error `Result` so the caller falls back to the text loop.
- Keep the edit minimal; if there is no exact heading, place these notes in the closest existing passage describing `tryStructuredPhase` / transactional apply.

## Phase 5: Verification gate

Commit message: `chore: verify structured-implement fix (typecheck, lint, coverage)`

### Step 1: Run the full gate and confirm green

From the repo root, run in order inside the Nix dev shell where required:

- `bun run typecheck` (i.e. `bunx tsc --noEmit`) — must pass with no errors.
- `bunx biome check --write .` — must pass; confirm no unused imports remain after the Phase 3 test deletion.
- `bun test --coverage` — all tests pass; coverage ≥ 90% on the changed files, with the Phase 2 catch block covered by the throwing-dispatcher test.
- Confirm no `TODO` comments and no commented-out code were introduced.

---

## Risks & assumptions

- **Scope of "fixed":** This makes plan-cycle decline directory-touching structured edits cleanly (error `Result` → text fallback) and guarantees `tryStructuredPhase` never throws. It explicitly does NOT make directory moves work — the text fallback cannot perform them either, and per the verified operating rule file moves should not appear in pipeline plans. **[SUPERSEDED]** Directory moves DO now work on the structured path in a git workspace; see the top-of-file note and `docs/plan-structured-directory-moves.md`.
- **Catch coverage:** The Phase 2 catch is now exercised by a real throwing-dispatcher test (a rejecting `dispatchPatch` is a genuine, reachable production path through `orchestratePatch`), so no `v8-ignore` pragma is used and coverage is honest.
- **Blast radius:** `snapshotTouchedPaths` is module-private with a single caller (`applyEditsTransactionally`), so changing its return to `Result<PathSnapshot[]>` touches nothing else. `PathSnapshot`, `rollbackToSnapshot`, and `verified-implement-step.ts` are untouched.
- **Fake dispatcher fidelity:** Tests rely on `structuredDispatcher` returning ops directly via `dispatchPatch` (no parsing), so ops must be valid `PatchOp`s (`create`→`contents`; `move`→`filePath`/`toPath`; `edit`→`search`/`replace`). The seeded `move` op is valid.
- **Assumption:** The colocated test file for this module is `structured-implement.test.ts` in the same directory; if the project convention differs, place the new tests wherever the existing `tryStructuredPhase` tests live.

## Strategy

Two small, surgical source changes make the failure impossible and the fallback reliable: (1) convert `snapshotTouchedPaths` to a `Result` that refuses existing-directory paths before any mutation, propagated by `applyEditsTransactionally`, so directory-touching edits decline instead of throwing `EISDIR`; and (2) wrap the whole `tryStructuredPhase` body in a try/catch so a rejecting `dispatchPatch` (the real reachable throw path via `orchestratePatch`) becomes an error `Result` rather than crashing plan-cycle. A focused test pair locks both behaviors: an EISDIR directory-move regression guard and a throwing-dispatcher never-throws test that gives the catch real coverage. Docs and the full typecheck/lint/coverage gate land in the same change per AGENTS.md.
