# ADR 0004: Apply-time (read-then-anchor) table-header rename expansion

## Status

Accepted, implementation complete.

## Context

`expandTableHeaderAnchors` (`ai-system/core/pipeline/steps/expand-table-anchor.ts`,
introduced per ADR 0002/0003) deterministically expands a narrow bare-header
`search` anchor (e.g. `[lints.clippy]`) to cover its full table body when the
model's `replace` renames/restructures the table (e.g. into `[lints]`). This
pass ran UP FRONT, before `applyEditsTransactionally`, and derived/validated
its expanded anchor against **predicted** in-batch content — the shared
`predict-batch-state.ts` fold, consumed with `simulatePartialEdits: true`.
`applyPatch` (`apply-patch-step.ts`), by contrast, always searched the **raw
on-disk bytes** read immediately before applying each edit.

These two content sources could disagree. Field evidence (parlang-phase0
plan-cycle runs, recorded across several cerebrum findings — search handle
"structured search anchor not found lints") showed a batch shaped as `move
Cargo.toml -> crates/parlang/Cargo.toml`, then an append-same-header body
mutation on `[lints.clippy]`, then the `[lints.clippy]` -> `[lints]` rename,
all in one structured-patch phase. On this batch, the up-front expansion pass
resolved the rename anchor against a predicted approximation that did not
reflect the preceding append edit's on-disk effect (the append is a
same-header pass-through, not a rename, and the prediction fold did not
simulate it for this shape). The expanded anchor therefore passed expansion
(`ok: true`) but **missed at apply time**: `applyPatch` returned `{ ok: false,
reason: "not-found", message: "Search anchor not found in ..." }`. This
surfaced as an `apply-failed` `StructuredDecline` (NOT the well-understood
`anchor-unexpandable` hard-abort class from ADR 0003), which the caller
correctly treated as a soft decline and fell back to the aider-text loop —
which then itself failed on chatty model text pollution, aborting the phase
with no commit.

Three consecutive prior fix attempts targeted this symptom without first
reproducing it in a test, and none resolved it — each shipped a plausible but
untested change against the running build, and the identical failure
recurred byte-for-byte across builds. This was explicitly called out as an
anti-pattern to break: **write a failing test that reproduces the exact
divergence first, confirm it fails for the right reason, then fix it and
confirm the same test goes green.**

## Decision

The predicted-vs-disk divergence is closed **at its source**: table-header
rename anchor expansion is no longer split across an up-front
prediction-based pass and a downstream disk-based apply. Instead:

- **`expandTableHeaderAnchorAgainstContent(edit, fileContent)`** is a new
  PURE, exported function in `expand-table-anchor.ts` that contains the
  entire per-edit expansion algorithm (replace-vs-append discriminator,
  descendant-aware table-body boundary scan, final-newline preservation, and
  the `anchor-unexpandable` hard-abort for a confirmed-rename anchor that
  cannot be uniquely resolved), operating on an explicit `fileContent: string
  | null` parameter instead of a predicted approximation. It never reads the
  filesystem and never calls `predictBatchStates`.
- **`applyPatch`** (`apply-patch-step.ts`) gained an `options.expandTableAnchors`
  flag (default `false`, so existing callers such as the incremental
  aider-text retry loop are unaffected). When enabled, immediately after
  reading a file's current on-disk bytes for a modification edit and BEFORE
  counting anchor occurrences, it calls
  `expandTableHeaderAnchorAgainstContent(edit, currentContent)` against those
  SAME just-read bytes. Because the anchor that is searched is derived from
  the identical content it is searched against, no predicted-vs-disk
  divergence is possible — for ANY batch shape (moves, multiple body
  mutations, interleaved partial edits, or orderings not yet seen). A
  confirmed-rename anchor that still cannot be uniquely resolved against
  actual bytes returns `{ ok: false, error: { reason: "anchor-unexpandable",
  ... } }`, extending `PatchApplyError.reason`.
- **`structured-implement.ts`**: `applyEditsTransactionally`'s two
  `applyPatch` call sites (the git-transactional and snapshot-rollback
  branches) now pass `{ expandTableAnchors: true }`, and map a resulting
  `anchor-unexpandable` `PatchApplyError.reason` through to the
  `StructuredDecline.reason` of the same name (preserving ADR 0003's
  hard-abort semantics — now decided against real bytes instead of
  predicted ones); every other `PatchApplyError` reason still maps to
  `apply-failed` as before. `tryStructuredPhase` no longer runs an up-front
  `expandTableHeaderAnchors` call at all — it passes `coerceCreatesToEdits`'s
  output straight through to `applyEditsTransactionally`.
- **`expandTableHeaderAnchors`** (the original batch-level function) is
  RETAINED, refactored to simply loop over `predictBatchStates(...)` and
  delegate each edit to `expandTableHeaderAnchorAgainstContent`. It is no
  longer on the production correctness path — it exists only as a
  non-authoritative, up-front diagnostic (and to keep its existing direct
  test coverage meaningful). Callers must not treat its output as what will
  actually be searched at apply time.

### Fixed test-first, with a real red→green transition

Per the explicit user directive to stop shipping speculative fixes, this
change was authored test-first as a single merged phase: a permanent
regression test reproducing the exact field batch shape (`move` →
append-same-header → rename, in `expand-table-anchor.apply.test.ts`) was
written FIRST and confirmed GENUINELY RED against the pre-fix tree —
specifically, `expandTableHeaderAnchors(...).ok === true` (proving the
up-front pass does not itself reject the batch) AND `applyPatch(...)`
returning `{ ok: false, reason: "not-found" }` with a message containing
`"Search anchor not found"` (proving the failure locus is the `apply-failed`
divergence class, not the `anchor-unexpandable` hard-abort). Only after that
red confirmation was the apply-time fix implemented, turning the same test
green. A second, reduced case (append → rename, no move) was added
alongside it. This **supersedes** the prediction-heuristic-tweak approach
(e.g. narrowing the M4 bare-header self-skip guard in
`predict-batch-state.ts` to special-case this one batch shape) that was
considered and explicitly rejected: narrowing a simulation guard closes only
the one reproduced shape and leaves the underlying divergence class open for
the next shape a model emits, repeating the failure pattern of the three
prior fixes. Removing prediction from the correctness path entirely is the
robust fix.

## Consequences

**Easier / more robust:**

- The predicted-vs-disk divergence class is closed structurally, not just for
  the one reproduced batch shape. Any future batch ordering (multiple
  preceding mutations, edits before AND after a move, etc.) anchors against
  the same real bytes `applyPatch` will search, by construction.
- `anchor-unexpandable` (ADR 0003's hard-abort) is now decided against actual
  on-disk content, which is strictly more trustworthy than a predicted
  approximation — the hard-abort can never fire (or fail to fire) based on a
  stale prediction.
- All previously-existing behavior is preserved unchanged: the
  replace-vs-append discriminator, the descendant-aware table-body boundary
  scan, final-newline preservation, and every non-`anchor-unexpandable`
  `StructuredDeclineReason`'s fallback-to-text-loop behavior.
- `tryStructuredPhase`'s and `applyEditsTransactionally`'s observable
  contracts are unchanged (same inputs/outputs, same `StructuredDecline`
  reasons), so the existing `structured-implement.test.ts` boundary tests
  (including the two ADR 0003 `anchor-unexpandable` cases) pass unmodified —
  they now exercise the apply-time seam instead of the up-front pass, without
  any test-expectation changes required.

**Harder / follow-up work:**

- `expandTableHeaderAnchors` (batch-level, prediction-based) is now a
  vestigial diagnostic. A future cleanup could remove it entirely and migrate
  its direct unit tests to call `expandTableHeaderAnchorAgainstContent`
  directly with explicit in-memory content; this ADR does not do so, to avoid
  widening this change's blast radius beyond the anchor-divergence fix.
- The previously-documented "KNOWN LIMITATION ... degrades safely" comment
  block in `expand-table-anchor.ts` was deleted as empirically false (the
  field path aborted the phase rather than degrading safely) and replaced
  with an accurate note describing the apply-time reconciliation.
