# Feature: Structured-path create-vs-edit determinism (B1) + structured-decline diagnostic surfacing

## Background & scope boundary (for implementers)

Two tightly-scoped changes to the **structured whole-phase patch path** only:

1. **Diagnostic (one-line general fix).** In `verified-implement-step.ts`, the `fell-back-to-text` progress event forwards `detail: structuredResult.error.detail`, but `detail` is only populated for the `dispatch-error` reason. For `apply-failed` (and `conversion-failed`, `threw`) `detail` is `undefined`, so the operator sees a bare reason with no root cause — even though the full underlying error is already in `structuredResult.error.message`. Fix: forward `detail ?? message`.

2. **B1 determinism.** `coerceCreatesToEdits` (`coerce-create-to-edit.ts`) is the sole structured-only, filesystem-aware seam before `applyEditsTransactionally`. It correctly coerces a `create` over an *already-on-disk* non-empty file into a whole-file-replace edit. **The gap:** it evaluates each edit independently against **current disk state**, but the whole-phase batch is applied transactionally *in order*. When a preceding `move` (or `create`) in the same batch **produces** the target file, the later `create`'s target does **not** yet exist on disk at coerce time → it passes through as a create → `applyPatch` runs the move first, then the create hits an existing non-empty file → `"already exists; cannot create"` → `apply-failed` → whole phase drops to text (finding `151af9e0`, `f83c8f69`). The fix makes `coerceCreatesToEdits` **batch-aware**: it simulates the predicted post-op content of touched paths as it walks the ops in order, so a create whose target is produced non-empty by an earlier op is coerced to a clean whole-file-replace edit.

**Confirmed scope note (from finding `151af9e0` + `plan:parlang-phase0`):** the reported failing payload is an in-batch **file** move (`Cargo.toml → crates/parlang/Cargo.toml`) followed by a create of that produced path — a file-content case the content-keyed fold fully handles. A `create` targeting a path *under a moved directory* is a known limitation of the flat content-keyed fold; it is **not** a regression (today's independent map fails it identically) and is out of scope here — documented in the fold's doc comment and the ADR.

**Explicit boundaries (do NOT cross):**
- Do **not** touch the aider-text fallback path (`writeImplementation`) or `applyPatch`'s shared create branch — it is used by both paths; hardening it risks the documented false-green class (partial-content overwrite with no rollback). The fix lives **only** in `coerce-create-to-edit.ts` (structured-only seam).
- Do **not** weaken the all-or-nothing transactional apply/rollback contract.
- Do **not** attempt to fix additive-insert edit drift (BUG 2, Symptom A) or structural assert vocabulary (TOML-exact-keys / `cargo metadata`). Those are owned by **`plan:false-green-gate-assert-v1`** (id `1e5b172a`). State this boundary in the ADR.
- Do **not** export private functions solely for testing — use existing seams (`createVerifiedImplementStep` with a mocked orchestrator; `tryStructuredPhase` via `structured-implement.test.ts` helpers).

**Honest end-state after this plan:** a structured run either applies cleanly OR aborts loudly; additive-edit drift (B2) may still occur and is caught by the separately-hardened asserts, not this plan.

---

## Phase 1: Surface structured-decline detail in the verbose progress feed

Commit message: `fix: surface structured decline detail for all fallback reasons`

### Step 1: Forward error message as detail fallback at the fell-back-to-text mapping site

Modify `ai-system/core/pipeline/steps/verified-implement-step.ts`. In the `else` branch that emits the `fell-back-to-text` progress event for a structured decline (currently around lines 592–599, the branch that reads `structuredResult.error.reason`), change the `detail` field of the emitted `patch-path` progress event from:

```ts
detail: structuredResult.error.detail,
```

to:

```ts
detail: structuredResult.error.detail ?? structuredResult.error.message,
```

Do NOT change either `StructuredDecline` return site in `structured-implement.ts`, do NOT add or populate any new field, and do NOT touch the other `fell-back-to-text` emission (the `verification-red-after-structured` branch). This single change makes a non-empty diagnostic detail render for EVERY decline reason (`apply-failed`, `conversion-failed`, `threw`, `directory-declined`), since `progress.ts` already renders `detail` when present and non-empty. If there is an inline code comment on the `detail` line, update it to note the message fallback covers non-`dispatch-error` reasons.

Assert: file `ai-system/core/pipeline/steps/verified-implement-step.ts` must contain `structuredResult.error.detail ?? structuredResult.error.message`.

### Step 2: Add progress.ts render tests for detail present/absent on an apply-failed fallback

Modify `ai-system/core/pipeline/progress.test.ts` (the file already exists). Add tests to the existing `describe("formatProgressEvent (patch-path)")` block (plain theme) proving detail rendering for the `fell-back-to-text` line:

1. A `patch-path` event `{ kind: "patch-path", phase: 1, path: "fell-back-to-text", reason: "apply-failed", detail: 'Failed to apply structured patch to "crates/parlang/Cargo.toml": File "crates/parlang/Cargo.toml" already exists; cannot create' }` must format to a string that ends with `: ` followed by that exact detail text — assert the rendered line contains `apply-failed` AND contains the detail substring `already exists; cannot create`.
2. The same event with `detail` omitted (undefined) must render cleanly with NO trailing `": "` — assert `formatProgressEvent(event, theme)` equals exactly `"= Phase 1  fell back to text loop (apply-failed)"` and does NOT end with `": "`.
3. The same event with `detail: ""` (empty string) must also render without a trailing `": "` — assert it equals `"= Phase 1  fell back to text loop (apply-failed)"`.

Use the existing `buildTheme(false)` plain theme and existing import style. Do not modify existing test cases.

Assert: file `ai-system/core/pipeline/progress.test.ts` must contain `already exists; cannot create`.

### Step 3: Add a verified-implement-step test asserting detail falls back to message

Modify `ai-system/core/pipeline/steps/verified-implement-step.test.ts`. Using ONLY the existing exported seam `createVerifiedImplementStep` with a mocked/stubbed orchestrator config (follow the existing mocking patterns already in this test file — do not export private functions), add a test that:

1. Drives the step so that `tryStructuredPhase` returns a `StructuredDecline` with `reason: "apply-failed"`, a populated `message` (e.g. containing `already exists; cannot create`), and `detail: undefined`. Arrange this via the existing structured-dispatch mocking approach used elsewhere in the file (a structured dispatcher whose emitted ops cause a transactional apply-failure, OR the existing helper that forces a decline — reuse whatever seam the file already uses to exercise the fallback branch).
2. Captures emitted progress events via the `onProgress` callback option.
3. Asserts that the emitted `patch-path` event with `path === "fell-back-to-text"` and `reason === "apply-failed"` has `detail` equal to the decline's `message` (i.e. the message fallback fired because `error.detail` was undefined), and that `detail` contains the underlying error text.

If exercising a real apply-failure through the step is impractical with existing helpers, instead assert the mapping through the smallest existing seam that reaches the `else` branch at lines ~592–599; keep the test hermetic (temp workspace via `mkdtempSync`, cleaned in `afterEach`). Add a doc comment on the test explaining it guards the "detail falls back to message for non-dispatch-error declines" contract.

Assert: file `ai-system/core/pipeline/steps/verified-implement-step.test.ts` must contain `fell-back-to-text`.

---

## Phase 2: Make the structured coercion batch-aware so no in-batch create-over-produced-file can apply-fail

Commit message: `fix: coerce in-batch create-over-existing to edit deterministically`

### Step 1: Rewrite coerceCreatesToEdits to simulate in-order predicted filesystem state

Rewrite `ai-system/core/pipeline/steps/coerce-create-to-edit.ts`. The current implementation maps each edit independently against current disk state (`edits.map(coerceOne)`), which misses the case where a preceding `move` or `create` in the SAME batch produces the target of a later `create`. Replace the independent map with an in-order fold that tracks the predicted content of every touched in-workspace path.

Requirements (keep the function's never-throws, never-mutates-input, returns-new-array contract, and its existing exported signature `coerceCreatesToEdits(workspace: string, edits: readonly PatchEdit[]): readonly PatchEdit[]`):

- Maintain a `Map<string, string | null>` keyed by the normalized absolute in-workspace path, holding each touched path's **predicted current content**, or `null` meaning "predicted absent/deleted". A path not present in the map has unknown state and must be resolved by reading disk on demand (`existsSync` → `readFileSync`, wrapped in try/catch that treats any failure as "absent/unknown", exactly as today).
- Define a helper `predictedContentOf(absPath): string | null` that returns the map entry if present, else reads disk (`existsSync ? readFileSync(utf8) : null`), defensively returning `null` on any read error. Do NOT put the value read from disk into the map unless an op writes it (keep disk reads lazy). **Invariant: read each untouched path from disk at most once; once an op has written a prediction for a path, always trust the prediction and never re-read disk for it — re-reading mid-fold would reintroduce the independence bug this fix closes.**
- Walk `edits` in order, building a new output array, and update predictions as you go:
  - **Non-create, non-move edit** (plain edit): pass through unchanged. It does not change existence; leave the predicted entry as-is (do not attempt to compute the post-edit content — plain edits over a create-target are pathological and out of scope; document this limitation in the doc comment).
  - **Move edit** (`isMove`): pass through unchanged. Update predictions to reflect the rename: set `predicted[dest] = predictedContentOf(source)` and set `predicted[source] = null`. Only compute for in-workspace, non-absolute endpoints; skip prediction updates for absolute or out-of-workspace endpoints (leave the applier/path-guard to handle those), and pass the move through unchanged regardless.
  - **Create edit** (`isCreate`): apply the SAME workspace/absolute-path guards currently in `coerceOne` (absolute path → pass through unchanged; resolves outside workspace → pass through unchanged; those must never read the filesystem). Then compute `current = predictedContentOf(resolvedAbsPath)`:
    - `current === null` (predicted absent) → genuine new file: pass the create through unchanged, then set `predicted[resolvedAbsPath] = edit.replace`.
    - `current === ""` (predicted EMPTY, whether empty on disk or produced empty by a prior op) → leave as a create (the applier's empty-file relaxation overwrites a 0-byte existing file deterministically); then set `predicted[resolvedAbsPath] = edit.replace`. Note in a comment: an empty target only exists on disk at apply time, so the applier relaxation applies.
    - `current === edit.replace` (byte-identical) → pass through unchanged (the applier treats an identical existing create as a no-op success); prediction stays `edit.replace`.
    - otherwise (predicted NON-EMPTY and differing) → COERCE to a whole-file-replace edit: `{ filePath: edit.filePath, search: current, replace: edit.replace, isCreate: false, isMove: false }`. Because a string cannot contain two non-overlapping copies of its own entirety, `search` matches exactly once, so the applier's edit branch applies cleanly. Then set `predicted[resolvedAbsPath] = edit.replace`.
- Preserve all existing safety properties: never throw, never mutate input edits, always return a new array, never perform path-safety checks (leave `assertInsideWorkspace` as the sole gate inside `applyPatch`), and never read outside the workspace.
- Update the module-level doc comment to describe the new batch-aware in-order semantics and explicitly state: this closes the case where a preceding in-batch `move`/`create` produces the target of a later `create` (finding `151af9e0`); plain-edit post-content is intentionally not simulated; and a `create` targeting a path under a moved *directory* is a known limitation of the flat content-keyed model (not a regression, owned nowhere yet — flag for a future plan if it surfaces).

Do NOT change `patchOpsToEdits`, `apply-patch-step.ts`, or `structured-implement.ts` — the call site `coerceCreatesToEdits(workspace, editsResult.value)` in `structured-implement.ts` is unchanged.

Assert: file `ai-system/core/pipeline/steps/coerce-create-to-edit.ts` must contain `isMove`.
Assert: file `ai-system/core/pipeline/steps/apply-patch-step.ts` must-not contain `writeImplementation`.

### Step 2: Extend coerce-create-to-edit.test.ts with in-batch move-then-create coverage

Modify `ai-system/core/pipeline/steps/coerce-create-to-edit.test.ts` (exists). Using a real temp workspace (`mkdtempSync`, cleaned in `afterEach`), add unit tests that call `coerceCreatesToEdits(workspace, edits)` directly and assert on the returned edit array shape (NOT on apply):

1. **In-batch move→create over produced NON-EMPTY file is coerced.** Seed a source file `a.txt` on disk with non-empty content `"OLD"`. Input edits (in order): a move `a.txt → b.txt`, then a create of `b.txt` with contents `"NEW"`. Assert the returned array's move edit is unchanged, and the create is coerced to `{ isCreate: false, isMove: false, search: "OLD", replace: "NEW", filePath: "b.txt" }`.
2. **In-batch move→create over produced EMPTY file stays a create.** Seed `a.txt` as a 0-byte file. Move `a.txt → b.txt`, then create `b.txt` with `"NEW"`. Assert the create passes through unchanged with `isCreate: true` (the applier relaxation handles it).
3. **Create over an already-on-disk NON-EMPTY file (no move) is still coerced** (regression for existing behavior): file `c.txt` exists with `"OLD"`, single create of `c.txt` with `"NEW"` → coerced to whole-file-replace with `search: "OLD"`.
4. **Genuine new-file create passes through unchanged**: create of `new.txt` (absent on disk, not produced by any prior op) stays `isCreate: true`.
5. **Byte-identical in-batch produced create passes through unchanged**: move `a.txt → b.txt` where `a.txt` contains `"SAME"`, then create `b.txt` with `"SAME"` → create passes through unchanged (no coercion), since apply is a no-op.

Add a doc comment on the new describe block referencing finding `151af9e0`.

Assert: file `ai-system/core/pipeline/steps/coerce-create-to-edit.test.ts` must contain `151af9e0`.

### Step 3: Add whole-phase structured-implement regression tests through the tryStructuredPhase seam

Modify `ai-system/core/pipeline/steps/structured-implement.test.ts` (exists). Using the existing `structuredDispatcher(ops)` helper and `tryStructuredPhase(event, config, workspace)` seam, and a real git-initialized temp workspace where the batch touches directories (or a plain non-git temp workspace for file-only batches — match the existing tests' workspace setup for each case), add tests that assert the WHOLE-PHASE transactional apply now succeeds (`result.ok === true`, value `"applied"`) and the resulting files have the expected contents:

1. **Move + create-over-produced-nonempty applies cleanly.** Seed `a.txt` = `"OLD"`. Ops: `{ kind: "move", filePath: "a.txt", toPath: "b.txt" }` then `{ kind: "create", filePath: "b.txt", contents: "NEW" }`. Assert `result.ok === true` (NOT an `apply-failed` decline) and `b.txt` ends with content `"NEW"`, and `a.txt` no longer exists. **This is the pinned regression for the reported file-move→create payload — first write it against the CURRENT code and confirm it FAILS at apply with `"already exists; cannot create"` after the move (not at coerce time), then apply the Step-1 fix and confirm it passes.**
2. **Create over a pre-existing NON-EMPTY file plus a sibling edit applies cleanly.** Seed `m.txt` = `"OLD"` and `s.txt` = `"anchor here"`. Ops: create `m.txt` with `"NEW"` and an edit of `s.txt` (`search: "anchor"`, `replace: "changed"`). Assert `result.ok === true`, `m.txt` === `"NEW"`, `s.txt` contains `"changed"`.
3. **Create over a pre-existing EMPTY file applies cleanly.** Seed `e.txt` as 0 bytes. Op: create `e.txt` with `"NEW"`. Assert `result.ok === true` and `e.txt` === `"NEW"`.
4. **Genuine create of a missing file still works.** Op: create `fresh.txt` (absent). Assert `result.ok === true` and `fresh.txt` === its contents.
5. **Regression for finding `151af9e0`:** the whole-phase apply for case 1 must NOT return `{ reason: "apply-failed" }`. Explicitly assert that when `result.ok === false` is unexpectedly hit, the test fails; and assert `result.ok === true`. Add a doc comment naming finding `151af9e0` as the guarded regression.

Reuse the file's existing temp-workspace + `afterEach` cleanup and git-init helpers (see the existing directory-move tests for the git-transactional setup). Do not export any private function to test this.

Assert: file `ai-system/core/pipeline/steps/structured-implement.test.ts` must contain `151af9e0`.

---

## Phase 3: Documentation — record the determinism guarantee and the deferred boundary

Commit message: `docs: record in-batch create-vs-existing determinism and decline-detail surfacing`

### Step 1: Update ADR 0002 with the batch-aware determinism guarantee and diagnostic surfacing

Modify `docs/adr/0002-structured-create-over-existing-coercion.md`. Update it (preserving existing tone and structure) to record:

1. In the **Decision** / `coerceCreatesToEdits` bullet: the coercion is now **batch-aware** — it simulates the in-order predicted filesystem state of touched paths, so a `create` whose target already exists on disk **OR is produced (non-empty) by a preceding `move`/`create` in the same whole-phase batch** is deterministically coerced to a clean whole-file-replace edit. Explicitly state the guarantee covers BOTH empty (via the applier's empty-file relaxation) and non-empty targets, and that a genuine new-file create still applies. Record the known limitation: a `create` targeting a path under a moved *directory* is not modeled by the flat content-keyed fold (not a regression).
2. In **Consequences**: add that structured-decline diagnostics are now surfaced for EVERY decline reason in the `--verbose` progress feed (the `fell-back-to-text` line forwards `detail ?? message`), not just `dispatch-error` — so an `apply-failed` fallback is no longer blind.
3. Reaffirm the deferred boundary: additive/malformed-edit drift (Symptom A / BUG 2) and structural assert vocabulary (TOML-exact-keys / `cargo metadata`) remain owned by **`plan:false-green-gate-assert-v1`** (id `1e5b172a`), NOT this change. Record the honest end-state: a structured run now either applies cleanly OR aborts loudly (and visibly), while additive-edit drift may still occur and is caught by the separately-hardened asserts.
4. Note that the fix is confined to the structured-only seam (`coerce-create-to-edit.ts`) and the text fallback path and shared applier were intentionally NOT hardened.

Assert: file `docs/adr/0002-structured-create-over-existing-coercion.md` must contain `1e5b172a`.
Assert: file `docs/adr/0002-structured-create-over-existing-coercion.md` must contain `batch-aware`.

### Step 2: Update architecture doc if the structured-apply behavior description changed

Modify `docs/architecture.md`. Locate the section describing the structured whole-phase patch path / `coerceCreatesToEdits` / structured apply behavior. If such a description exists, update it to state that create-over-existing coercion is batch-aware (covers in-batch move/create-produced targets) and that structured declines surface a diagnostic detail in the verbose feed. If no such description exists, add a concise sentence to the most relevant structured-patch/pipeline subsection cross-referencing ADR 0002. Keep the edit minimal and consistent with surrounding tone. Per the AGENTS.md docs-in-same-commit rule, this must land in the same phase as the behavior change is documented.

Assert: file `docs/architecture.md` must contain `coerce`.

---

## Risks & assumptions

1. **Root-cause assumption confirmed.** The observed `apply-failed` is the in-batch **file** move→create ordering (coerce reads disk before the move applies), per findings `151af9e0` / `f83c8f69` and `plan:parlang-phase0` (Cargo.toml moved as a file). Phase 2 Step 3 case 1 pins this by reproducing it as a failing test against current code first.
2. **Directory-move blind spot (known limitation, not a regression).** A `create` targeting a path under a moved *directory* is not modeled by the flat content-keyed fold. The reported bug is a file move, so this does not affect it; documented in the fold and ADR.
3. **Empty-file in-batch case relies on the applier relaxation at apply time.** A move producing a 0-byte file means the target exists (empty) when the create runs, and `apply-patch-step.ts` (~161–165) overwrites an empty existing file. Verified present. The plan deliberately does NOT coerce the empty case (a whole-file-replace with `search: ""` would be ambiguous) — it leaves it as a create.
4. **No B2 false-green introduced.** A coerced whole-file-replace uses the entire predicted file as the search anchor; a wrong prediction yields `searchCount === 0` → hard apply-fail → clean drop to text. Whole-file replace is all-or-nothing; it cannot land a partial/incorrect edit. Safe-fail, not false-green.
5. **Transactional contract untouched.** Coercion runs before `applyEditsTransactionally`; snapshot/rollback and the git-transactional directory path are unchanged.
6. **Coverage gate.** Each phase must independently pass `bun run typecheck`, `bunx biome check --write .`, and `bun test --coverage` (≥90%). The new batch-fold branches each have a dedicated test in Phase 2 Step 2.

## Strategy summary

Phase 1 is a self-contained one-line diagnostic fix plus tests — it makes every structured decline visible in `--verbose`, which is what made B1 hard to observe. Phase 2 closes B1 by upgrading the structured-only `coerceCreatesToEdits` seam from independent per-edit disk checks to an in-order, batch-aware content prediction, so a `create` whose target is produced by a preceding in-batch `move`/`create` is deterministically coerced to a clean whole-file-replace edit — no stray create-op can apply-fail the transaction, while the empty-file, byte-identical, genuine-new, and out-of-workspace cases keep their current safe behavior and the transactional/rollback contract is untouched. Phase 3 records the guarantee and the deliberately deferred B2 boundary. The text fallback and shared applier are intentionally left alone to avoid the documented partial-overwrite false-green class.
