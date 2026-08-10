# Feature: Hard-abort confirmed-rename anchor expansion (`anchor-unexpandable` decline) + opt-in partial-edit simulation

## Context (confirmed by investigation)
- `expandTableHeaderAnchors` (`ai-system/core/pipeline/steps/expand-table-anchor.ts`) currently returns `readonly PatchEdit[]` and never fails — every unresolvable case does `result.push(edit); continue;`, so a confirmed-rename anchor that can't be uniquely located silently reaches the verbatim applier.
- Sole production caller: `tryStructuredPhase` (`structured-implement.ts:356`); only other callers are `expand-table-anchor.test.ts` and `expand-table-anchor.apply.test.ts`.
- `StructuredDeclineReason` is a string-literal union in the zero-import root `ai-system/shared/event-types.ts:116-124`. `StructuredPatchReason = StructuredDeclineReason | "structured-applied"` (L132). There is NO exhaustive `switch` over these anywhere; the only manual enumeration is `ALL_REASONS` in `progress.test.ts:160`.
- `formatProgressEvent` (`progress.ts:159-169`) renders a `patch-path` event with `path: "structured-applied" | "fell-back-to-text"`; the detail-render is currently gated on `path === "fell-back-to-text"` only.
- `StructuredDecline` (`structured-implement.ts:27`) has an optional `detail?` field.
- `verified-implement-step.ts:592-603` is the structured-declined `else` branch: emits `fell-back-to-text` then falls through into the retry `for` loop at L606.
- `phase-runner.ts`: on `!result.ok` it calls `attributePhaseFailure` + `restoreWorkingTree` and returns — no outer per-step retry re-invokes the step, so a returned error `Result` is terminal.
- `predict-batch-state.ts` rule 4 deliberately does not simulate plain partial edits.
- `docs/adr/` exists (`0001-...`, `0002-...` → next is `0003`).
- Canned-ops boundary replay style: `structured-implement.test.ts:583-625` uses `structuredDispatcher([...])` + `writeFileSync` + `tryStructuredPhase(makeEvent(), config, workspace)` then byte-asserts.

## Assumptions (explicit)
1. The abort surfaces as a new `path` literal `"structured-aborted"` on the existing `patch-path` progress event, NOT a new event kind.
2. `expandTableHeaderAnchors` returns `Result<readonly PatchEdit[], AnchorExpansionError>` where `AnchorExpansionError = { readonly filePath: string; readonly reason: "anchor-unexpandable"; readonly message: string }` (no `detail` field — the abort event's detail derives from `message`).
3. The hard-abort in `verified-implement-step` returns an error `Result<StepResult>` (idiomatic, non-throwing); this is terminal per `phase-runner.ts`.
4. `Result<T,E>` is the project's `{ ok: true; value } | { ok: false; error }` from `@ai-coding/shared`.
5. "Confirmed rename shape" = canonical `search` is a bare header AND canonical replace-first-line is a bare header AND the two canonical headers differ. Only this shape can abort; every other shape passes through unchanged.

---

## Phase 1: Opt-in partial-edit simulation in the shared batch-state fold
Commit message: `feat: add opt-in simulatePartialEdits to batch-state predictor`

### Step 1: Add `escapeRegExp` and `canonicalizeHeader` helpers to predict-batch-state.ts
In `ai-system/core/pipeline/steps/predict-batch-state.ts`, add two exported pure helpers (after imports, before `resolveInWorkspace`):
- `export function escapeRegExp(literal: string): string` → `literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`. TSDoc: escapes a string for safe use as a literal inside a `RegExp`.
- `export function canonicalizeHeader(raw: string): string` → `raw.trim().replace(/\s*#.*$/, "").trimEnd()`. TSDoc: reduces a TOML header line to canonical bare form by stripping surrounding whitespace and any trailing `#` comment, so `"[lints.clippy]  # note"` and `"[lints.clippy]"` compare equal.

Do not change existing exports or behavior in this step.

Assert: `rg -n 'export function escapeRegExp' ai-system/core/pipeline/steps/predict-batch-state.ts` returns 1 match.
Assert: `rg -n 'export function canonicalizeHeader' ai-system/core/pipeline/steps/predict-batch-state.ts` returns 1 match.
Assert: `bun run typecheck` exits 0.

### Step 2: Add `simulatePartialEdits` option to the predictor factory and generator, with a bare-header self-skip guard
In the same file:
- Change `createBatchStatePredictor(workspace: string)` to `createBatchStatePredictor(workspace: string, simulatePartialEdits = false): BatchStatePredictor`.
- In the `record` closure, replacing the final "plain partial edit: not simulated" no-op: when `simulatePartialEdits === true` AND the edit is a plain partial edit (not `isMove`, not `isCreate`, not `wholeFileReplace`) AND `edit.search !== ""`: compute `const abs = resolveInWorkspace(workspace, edit.filePath)`; if `abs === undefined` return. Read `const current = predictedContentOf(abs)`; if `current === null` return. **M4 GUARD:** if `canonicalizeHeader(edit.search)` matches the bare-header regex `/^\[\[?[^\]\n]+\]\]?$/` (search is itself a bare table header), do NOT simulate — return without mutating the map. Otherwise count occurrences via `current.split(edit.search).length - 1`; only when the count is exactly 1, `predicted.set(abs, current.replace(new RegExp(escapeRegExp(edit.search)), () => edit.replace))` (function replacer avoids `$&`/`$1` interpretation). When the flag is off (default), preserve the exact current no-op behavior.
- Change `predictBatchStates(workspace, edits)` to accept optional third param `options?: { readonly simulatePartialEdits?: boolean }` and pass `options?.simulatePartialEdits ?? false` into `createBatchStatePredictor`.
- Update the module TSDoc rule list to document the conditional fifth behavior, the bare-header self-skip, and that the default is off (so `coerceCreatesToEdits` is unchanged).

Do not change `resolveInWorkspace`, the move rule, create rule, or whole-file-replace rule.

Assert: `rg -n 'simulatePartialEdits' ai-system/core/pipeline/steps/predict-batch-state.ts` returns at least 4 matches.
Assert: `bun run typecheck` exits 0.

### Step 3: Tests for simulatePartialEdits
In `ai-system/core/pipeline/steps/predict-batch-state.test.ts` (create if absent; temp-dir + `writeFileSync` style), add `describe("predictBatchStates (simulatePartialEdits)")` with cases:
1. **Default off**: a plain partial edit followed by a second edit on the same file → second's `predictedContentForFilePath` equals ORIGINAL on-disk bytes (proves `coerceCreatesToEdits` consumer unchanged).
2. **On, single literal match**: with `{ simulatePartialEdits: true }`, a later edit sees the post-replace predicted content.
3. **On, zero or ≥2 matches**: prediction left as original bytes.
4. **On, M4 bare-header self-skip**: a partial edit whose `search` is `"[lints.clippy]"` (single occurrence) does NOT mutate the prediction — later edit sees original bytes.
5. **`$&` safety**: a `replace` containing `"$&"` is inserted literally.

Assert: `bun test ai-system/core/pipeline/steps/predict-batch-state.test.ts` passes.

---

## Phase 2: Introduce the `anchor-unexpandable` reason and the `structured-aborted` progress path
Commit message: `feat: add anchor-unexpandable structured decline reason and aborted progress path`

### Step 1: Extend the reason union in the zero-import root
In `ai-system/shared/event-types.ts`, add `| "anchor-unexpandable"` to the `StructuredDeclineReason` union (L116-124). Update the union's TSDoc to describe it: a confirmed table-header rename anchor that could not be uniquely resolved (0 or >1 canonical matches, or target predicts absent), which the caller must treat as a hard-abort with NO aider-text fallback (distinct from `apply-failed`, which still falls back). Add NO import to this file (HARD-RULE zero-import root).

Assert: `rg -n 'anchor-unexpandable' ai-system/shared/event-types.ts` returns at least 1 match.
Assert: `bun run typecheck` exits 0.

### Step 2: Add the `structured-aborted` path literal and widen the detail-render gate
In `ai-system/core/pipeline/progress.ts`:
- In the `patch-path` variant of the `ProgressEvent` union (~L51-63), widen `path` to also include `"structured-aborted"`.
- In `formatProgressEvent`'s `case "patch-path"` (~L159-169): add a branch so when `event.path === "structured-aborted"` the base string reads `Phase ${event.phase}  structured patch ABORTED (${event.reason})`. **Widen the existing detail-render gate** so detail is appended (`: ${event.detail}`) for BOTH `"fell-back-to-text"` AND `"structured-aborted"` when `event.detail` is a non-empty string. Keep `structured-applied` and `fell-back-to-text` base branches unchanged.

Assert: `rg -n 'structured-aborted' ai-system/core/pipeline/progress.ts` returns at least 2 matches.
Assert: `bun run typecheck` exits 0.

### Step 3: Cover the new reason and path in the progress renderer test
In `ai-system/core/pipeline/progress.test.ts`: add `"anchor-unexpandable"` to the manual `ALL_REASONS` array (~L160). Add a dedicated test asserting a `{ kind: "patch-path", phase: 1, path: "structured-aborted", reason: "anchor-unexpandable", detail: "<msg>" }` event renders a line containing `ABORTED`, `anchor-unexpandable`, AND (explicitly) ending with the detail text — proving the widened detail gate.

Assert: `bun test ai-system/core/pipeline/progress.test.ts` passes.

---

## Phase 3: Rewrite `expandTableHeaderAnchors` to a `Result` and fix its caller in the same commit
Commit message: `refactor: expandTableHeaderAnchors returns Result with anchor-unexpandable hard-decline`

*(The caller rewrite is included in this phase so no commit lands with a red typecheck.)*

### Step 1: Define `AnchorExpansionError` and change the return type
In `ai-system/core/pipeline/steps/expand-table-anchor.ts`:
- Import `Result` from `@ai-coding/shared` and `canonicalizeHeader` from `./predict-batch-state` (keep the existing `predictBatchStates` import).
- Export `interface AnchorExpansionError { readonly filePath: string; readonly reason: "anchor-unexpandable"; readonly message: string; }` with TSDoc explaining it signals a confirmed table-header rename anchor that could not be uniquely resolved and must hard-abort the phase (no text fallback).
- Change signature to `export function expandTableHeaderAnchors(workspace: string, edits: readonly PatchEdit[]): Result<readonly PatchEdit[], AnchorExpansionError>`. Success paths accumulate into `result`; return `{ ok: true, value: result }` at the end. Update TSDoc: still pure, still never throws, but may now return an error `Result` for the confirmed-rename-unresolvable class; all NON-rename shapes still pass through unchanged in the ok array.

### Step 2: Relax the gates with canonicalization and enable partial-edit simulation
In the body:
- Iterate `predictBatchStates(workspace, edits, { simulatePartialEdits: true })`.
- `const canonSearch = canonicalizeHeader(edit.search)`. Gate 1 tests `bareHeaderGate.test(canonSearch)` (relaxes so trailing-comment/whitespace headers qualify).
- Compute first non-empty replace line, then `const canonReplace = canonicalizeHeader(firstNonEmptyReplaceLine ?? "")`. Gate 2 tests `bareHeaderGate.test(canonReplace)`.
- **Append-skip discriminator (canonical vs canonical):** `if (canonReplace === canonSearch) { result.push(edit); continue; }` — a trailing-comment append cannot slip past and delete a body.
- Keep the `isCreate`/`isMove` and multi-line/non-header pass-throughs (return into the ok array untouched).

### Step 3: Make the confirmed-rename-unresolvable class hard-decline (M3 + unique-match)
Within the confirmed-rename branch (canonical bare `search` header, canonical bare `replace` header, `canonReplace !== canonSearch`):
- **Predicted-absent (M3):** if `predictedContentForFilePath === null`, return `{ ok: false, error: { filePath: edit.filePath, reason: "anchor-unexpandable", message: \`Confirmed table-header rename anchor "${edit.search.trim()}" targets "${edit.filePath}", which predicts absent (e.g. an edit emitted against a pre-move source path); cannot uniquely resolve — aborting.\` } }`.
- **Match counting by canonical equality:** count full-line matches where `canonicalizeHeader(line) === canonSearch`, tracking `headerIdx` and `matchCount`.
- **Not uniquely resolvable:** if `matchCount !== 1`, return `{ ok: false, error: { filePath: edit.filePath, reason: "anchor-unexpandable", message: \`Confirmed table-header rename anchor "${edit.search.trim()}" matched ${matchCount} candidate header lines in "${edit.filePath}"; a unique anchor is required — aborting.\` } }`.
- On the unique-match path: build `expandedSearch` from RAW predicted bytes (`lines.slice(headerIdx, endExclusive).join("\n")`) via the existing boundary scan (unchanged); if `expandedSearch === edit.search` push the original edit, else push the expanded edit — both into the ok array.
- Add a TSDoc note: only this well-understood confirmed-rename-unresolvable class hard-declines; generic apply failures elsewhere are unaffected.

### Step 4: Fix the sole production caller in this same commit
In `ai-system/core/pipeline/steps/structured-implement.ts`, inside `tryStructuredPhase`, replace the single expression at L354-357:
- `const expansion = expandTableHeaderAnchors(workspace, coerceCreatesToEdits(workspace, editsResult.value));`
- If `!expansion.ok`, return `{ ok: false, error: { reason: expansion.error.reason, message: expansion.error.message } }` — propagate the `"anchor-unexpandable"` reason directly (NOT `apply-failed`). Type-checks because `StructuredDecline.reason` now includes it.
- Otherwise call `applyEditsTransactionally(workspace, expansion.value)` as before.
- Update `tryStructuredPhase` TSDoc: a confirmed-rename anchor that cannot be uniquely resolved declines with `anchor-unexpandable`, which the caller treats as a hard-abort rather than a text-loop fallback.

### Step 5: Update the two anchor test files for the Result shape (with m6 ambiguity)
Update `expand-table-anchor.test.ts` and `expand-table-anchor.apply.test.ts`:
- Unwrap every existing call: `expect(result.ok).toBe(true); if (result.ok) { /* assert against result.value */ }`, preserving every existing behavioral assertion.
- Add: confirmed rename anchor whose header is **absent** → `result.ok === false`, `result.error.reason === "anchor-unexpandable"`.
- Add (**m6**): two `[lints.clippy]` header lines differing ONLY by a trailing `# comment` (not byte-identical) + confirmed rename → `result.ok === false`, reason `anchor-unexpandable` (proves canonical-equality counting).
- Add (**M3**): an in-batch move nulls the source path, then a confirmed rename edit targets that now-absent source → `result.ok === false`, reason `anchor-unexpandable`.
- Add: a same-canonical-header append where the replace header carries a trailing comment (`[lints.clippy] # x`) → passes through unchanged in `result.value` (body NOT deleted).

Assert: `rg -n 'Result<readonly PatchEdit\[\], AnchorExpansionError>' ai-system/core/pipeline/steps/expand-table-anchor.ts` returns 1 match.
Assert: `rg -n 'reason: "anchor-unexpandable"' ai-system/core/pipeline/steps/expand-table-anchor.ts` returns exactly 2 matches.
Assert: `rg -n 'simulatePartialEdits: true' ai-system/core/pipeline/steps/expand-table-anchor.ts` returns 1 match.
Assert: `rg -n 'expansion.error.reason' ai-system/core/pipeline/steps/structured-implement.ts` returns 1 match.
Assert: `bun run typecheck` exits 0 (no red window — caller fixed in this same commit).
Assert: `bun test ai-system/core/pipeline/steps/expand-table-anchor.test.ts ai-system/core/pipeline/steps/expand-table-anchor.apply.test.ts` passes.

---

## Phase 4: Boundary regression tests at the `tryStructuredPhase` seam (the real live shape)
Commit message: `test: byte-exact boundary coverage for lints table rename and anchor-unexpandable decline`

### Step 1: Clean sole-entry table on the real rename shape
In `ai-system/core/pipeline/steps/structured-implement.test.ts`, add a canned-ops boundary test (mirror `structuredDispatcher([...])` + `writeFileSync` + `tryStructuredPhase(makeEvent(), config, workspace)` at L583-625):
- Write an on-disk `Cargo.toml` with a multi-line `[lints.clippy]` table whose body is `pedantic = "warn"`, `module_name_repetitions = "allow"`, `must_use_candidate = "allow"`, followed by an unrelated `[dependencies]` header (boundary terminator).
- Dispatch a single edit op: `search = "[lints.clippy]"`, `replace = "[lints]\nworkspace = true"`.
- Assert `result.ok === true` and byte-exact content: the `[lints.clippy]` table (header + all three body keys) is fully replaced by the sole-entry `[lints]\nworkspace = true`, with NO dangling `pedantic`/`module_name_repetitions`/`must_use_candidate` keys, and `[dependencies]` preserved.
- Variant: on-disk header carries a trailing comment (`"[lints.clippy] # lints"`) → still resolves and produces the clean table.

### Step 2: Unresolvable confirmed rename declines with `anchor-unexpandable`, tree untouched
Add a boundary test: an on-disk file that does NOT contain `[lints.clippy]` (or contains it twice differing only by trailing comment), dispatched with `search = "[lints.clippy]"`, `replace = "[lints]\nworkspace = true"`. Assert `result.ok === false`, `result.error.reason === "anchor-unexpandable"`, and the on-disk file is byte-for-byte untouched (no partial mutation).

Assert: `bun test ai-system/core/pipeline/steps/structured-implement.test.ts` passes.

---

## Phase 5: Hard-abort in `verified-implement-step` for `anchor-unexpandable`
Commit message: `feat: hard-abort the phase on anchor-unexpandable with no text fallback`

### Step 1: Branch the structured-declined path to abort only for anchor-unexpandable
In `ai-system/core/pipeline/steps/verified-implement-step.ts`, in the structured-declined `else` branch (L592-603), BEFORE emitting the existing `fell-back-to-text` event, add `if (structuredResult.error.reason === "anchor-unexpandable") { ... }`:
- Emit `options.onProgress?.({ kind: "patch-path", phase: options.phaseNumber ?? 0, path: "structured-aborted", reason: "anchor-unexpandable", detail: structuredResult.error.message });`
- Return a loud, named error `Result<StepResult>`: `return { ok: false, error: new Error(\`Phase ${options.phaseNumber ?? 0} aborted: structured patch declined with anchor-unexpandable (no aider-text fallback): ${structuredResult.error.message}\`) };` — bypassing the text `for` loop entirely.
- Leave the existing `else` behavior (emit `fell-back-to-text` + fall through into the retry loop) unchanged for EVERY other reason (`apply-failed`, `directory-declined`, `dispatch-error`, `conversion-failed`, `threw`, not-capable reasons).
- Add a comment: only `anchor-unexpandable` — the well-understood confirmed-rename-unresolvable class — hard-aborts; all other structured failures keep the historical text-loop fallback.

Assert: `rg -n 'structured-aborted' ai-system/core/pipeline/steps/verified-implement-step.ts` returns 1 match.
Assert: `rg -n 'anchor-unexpandable' ai-system/core/pipeline/steps/verified-implement-step.ts` returns 1 match.
Assert: `bun run typecheck` exits 0.

### Step 2: Test the hard-abort control flow — no text-loop retry, tree untouched
In `ai-system/core/pipeline/steps/verified-implement-step.test.ts` (existing harness; reuse `onProgress` capture + mock config), add a test that drives a phase whose structured attempt declines with `anchor-unexpandable`:
- Assert the returned step `Result` is `ok === false` and the error message contains `anchor-unexpandable`.
- Assert a `patch-path` progress event with `path: "structured-aborted"` and `reason: "anchor-unexpandable"` was emitted.
- Assert NO `patch-path` event with `path: "fell-back-to-text"` and NO `step-retry` event was emitted (proves the aider-text loop was never entered).
- Assert the touched workspace file is byte-for-byte unchanged.
- Companion assertion (adjacent test): an `apply-failed` decline STILL emits `fell-back-to-text` and enters the retry loop (guards the boundary).

Assert: `bun test ai-system/core/pipeline/steps/verified-implement-step.test.ts` passes.

---

## Phase 6: Documentation
Commit message: `docs: document anchor-unexpandable hard-abort and partial-edit simulation`

### Step 1: Update architecture.md
In `docs/architecture.md`, update the `expandTableHeaderAnchors` section and the `StructuredDeclineReason`/`StructuredPatchReason` section to document: (a) the function now returns `Result<readonly PatchEdit[], AnchorExpansionError>`; (b) the new `anchor-unexpandable` reason and that it HARD-ABORTS the phase with no aider-text fallback (contrast with `apply-failed`, which still falls back); (c) the new `structured-aborted` progress `path`; (d) the opt-in `simulatePartialEdits` fold behavior and its bare-header self-skip guard. Keep the ordering note (`patchOpsToEdits → coerceCreatesToEdits → expandTableHeaderAnchors → applyEditsTransactionally`) accurate.

Assert: `rg -n 'anchor-unexpandable' docs/architecture.md` returns at least 1 match.
Assert: `rg -n 'simulatePartialEdits' docs/architecture.md` returns at least 1 match.

### Step 2: Add ADR 0003
Create `docs/adr/0003-anchor-unexpandable-hard-abort.md` in the existing ADR format (Title, Status, Context, Decision, Consequences). Record: the dangling-body / anchor-not-found defect; the decision to hard-abort the confirmed-rename-unresolvable class via a dedicated `anchor-unexpandable` reason (rather than a message-prefix string-match, so the compiler covers every enumeration); the M4 bare-header self-skip in partial-edit simulation; why generic apply failures deliberately still fall back to the aider-text loop; the `simulatePartialEdits` asymmetry (on for expand, off for coerce); and a note that phase-level `attributePhaseFailure` may reattribute the top-level message in production even though the step-level abort is honest.

Assert: `rg -n 'anchor-unexpandable' docs/adr/0003-anchor-unexpandable-hard-abort.md` returns at least 1 match.

---

## Mandatory pre-PR gates (run in order, all must pass)
```
bun run typecheck
bunx biome check --write .
bun test --coverage
```
Assert: `bun run typecheck` exits 0.
Assert: `bunx biome check .` exits 0 (no diagnostics after `--write`).
Assert: `bun test --coverage` reports overall line coverage ≥ 90% and exits 0, with no coverage regression on `expand-table-anchor.ts`, `predict-batch-state.ts`, `structured-implement.ts`, `verified-implement-step.ts`, and `progress.ts`.

---

**Strategy:** Introduce the machine-checked `anchor-unexpandable` reason at the zero-import root, then thread it outward: the pure `expandTableHeaderAnchors` becomes a `Result` that hard-declines only the confirmed-rename-unresolvable shape (predicted-absent, zero, or ambiguous canonical matches) — with its sole caller rewritten in the same commit to avoid a red-typecheck window; `tryStructuredPhase` propagates the reason verbatim; `verified-implement-step` grows one guarded branch that aborts loudly for exactly this reason while every other decline keeps today's text-loop fallback. Opt-in `simulatePartialEdits` (with a bare-header self-skip) lets expansion see earlier in-batch partial edits without injecting a self-corrupting prediction. Byte-exact boundary tests replay the real live edit shape, and `tsc` guarantees the reason union is consistently handled.
