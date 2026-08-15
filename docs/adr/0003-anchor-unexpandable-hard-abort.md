# ADR 0003: Hard-abort confirmed-rename anchor expansion (`anchor-unexpandable`)

## Status

Accepted, implementation complete.

## Context

`expandTableHeaderAnchors` (`ai-system/core/pipeline/steps/expand-table-anchor.ts`,
see ADR 0002 mitigation 3) deterministically expands a narrow bare-header
`search` anchor (e.g. `[lints.clippy]`) to cover its full table body when the
model's `replace` restructures/renames the table (e.g. into `[lints]`). Prior
to this change, when that CONFIRMED-RENAME shape's anchor could not be
uniquely resolved against the predicted file content — the target predicted
absent, or the canonical header matched zero or more than one line — the
function silently pushed the ORIGINAL, un-expanded edit through unchanged and
let the downstream applier's own not-found/ambiguous-match handling degrade
to the aider-text fallback loop.

This "degrade silently, let something downstream catch it" behavior was
itself the residual risk this whole normalization pass exists to close: a
confirmed rename whose anchor can't be uniquely resolved is EXACTLY the shape
that, left un-expanded, reproduces the original dangling-table-body defect
(the applier's faithful substitution replaces only the matched header line,
leaving the old body orphaned) — except now silently, because the function
had already "handled" the case by declining to expand rather than by
signaling that it couldn't.

## Decision

**`expandTableHeaderAnchors` now returns `Result<readonly PatchEdit[],
AnchorExpansionError>`** instead of a bare array. It remains pure (never
throws) and every non-confirmed-rename shape (creates, moves, non-header
search, append-same-header) still passes through unchanged in the ok array.
But the confirmed-rename-unresolvable class — a canonical bare `search`
header AND canonical bare `replace` header that differ, whose anchor cannot
be uniquely resolved — now returns `{ ok: false, error: { reason:
"anchor-unexpandable", filePath, message } }`.

A new machine-checked `StructuredDeclineReason` value, `anchor-unexpandable`,
was added to the string-literal union in `ai-system/shared/event-types.ts`
(the zero-import graph root) specifically so the compiler enforces every
enumeration site. This was deliberately chosen over a message-prefix
string-match convention (e.g. checking `error.message.startsWith("Confirmed
table-header rename anchor")`), which would be silently un-checked by `tsc`
if the message wording ever drifted.

`tryStructuredPhase` (`structured-implement.ts`) propagates
`expansion.error.reason` / `expansion.error.message` verbatim into its own
`StructuredDecline` return when `expandTableHeaderAnchors` declines, rather
than collapsing it into the generic `apply-failed` reason.

`verified-implement-step.ts` grows exactly one new guarded branch in the
structured-declined `else` path: when `structuredResult.error.reason ===
"anchor-unexpandable"`, it emits a `patch-path` progress event with the new
`path: "structured-aborted"` literal (added to `progress.ts`'s `ProgressEvent`
union, with `formatProgressEvent` rendering `Phase ${n}  structured patch
ABORTED (${reason})` and appending `: ${detail}` when present — the same
detail-render gate that already covered `fell-back-to-text` was widened to
also cover `structured-aborted`), then returns a loud, named error `Result`
and returns immediately — WITHOUT entering the aider-text retry `for` loop.
Per `phase-runner.ts`, a returned error `Result` from a step is terminal:
there is no outer per-step retry that re-invokes the step, so this is a true
hard-abort of the phase.

**Every OTHER structured-decline reason is deliberately left unchanged** and
still falls back to the aider-text loop: `apply-failed`, `directory-declined`,
`dispatch-error`, `conversion-failed`, `threw`, and the two `not-capable-*`
reasons. Only `anchor-unexpandable` — the one well-understood,
narrowly-scoped defect class this normalization pass was written specifically
to close — earns a hard-abort. Generic apply failures elsewhere in the
pipeline (a stale anchor from an unrelated cause, a transient dispatch error,
etc.) are NOT well-understood enough to assume a text-loop retry can't
recover, so they keep the historical, more forgiving fallback.

### `simulatePartialEdits` (opt-in, asymmetric between the two consumers)

`expandTableHeaderAnchors` and `coerceCreatesToEdits` both consume the shared
`predict-batch-state.ts` fold. Previously neither pass simulated a plain
partial edit's post-edit content (rule 4: "not simulated" for both). This
change adds a fifth, OPT-IN rule to the fold (`simulatePartialEdits`, default
`false`): when a plain partial edit's `search` matches the current predicted
content EXACTLY ONCE, the fold updates the prediction to the post-replace
content (using a function replacer so a `replace` containing `$&`/`$1` is
inserted literally, never interpreted as a `RegExp` special-replacement
pattern). `expandTableHeaderAnchors` now opts IN to this (so it sees earlier
in-batch partial edits when resolving a rename anchor); `coerceCreatesToEdits`
deliberately does NOT opt in, so its behavior is byte-for-byte unchanged by
this flag's introduction. This asymmetry is intentional: `coerceCreatesToEdits`
only needs to know whether a target exists (move/create semantics), not its
exact simulated body, so extending its fold would only add risk without
benefit.

**M4 bare-header self-skip guard:** the fold explicitly refuses to simulate
when the partial edit's `search` is ITSELF a bare table header (matches the
same bare-header regex `expandTableHeaderAnchors` uses to detect a rename
anchor). Without this guard, a plain partial edit whose search happens to be
a bare header could seed the shared prediction map with an already-corrupted
(dangling-body) intermediate state, which `expandTableHeaderAnchors` would
then read back as if it were ground truth — silently reintroducing the exact
defect class this whole feature closes, just one layer removed. The guard
ensures `expandTableHeaderAnchors`'s own anchor-expansion logic is always the
one authority that resolves a header-shaped anchor's boundaries.

## Consequences

**Easier:**
- A confirmed-rename anchor that can't be uniquely resolved now fails LOUDLY
  and SPECIFICALLY, with a named `Error` and a `--verbose` progress line
  (`structured patch ABORTED (anchor-unexpandable): <diagnostic message>`)
  instead of silently degrading through a generic fallback path where the
  root cause (an ambiguous or absent rename anchor) is easy to lose in the
  noise of a subsequent aider-text-loop failure.
- The compiler enforces exhaustive handling of `StructuredDeclineReason` at
  every switch/branch site that cares, because `anchor-unexpandable` is a
  first-class member of the union, not a string convention.
- `expandTableHeaderAnchors` can now see in-batch partial-edit effects when
  resolving a rename anchor (via opt-in `simulatePartialEdits`), closing one
  more slice of the "predicted vs. actual batch state" gap without touching
  `coerceCreatesToEdits`'s proven-stable behavior.

**Harder / follow-up work:**
- A hard-abort is, by design, less forgiving than a fallback: a
  confirmed-rename edit that hits an anchor ambiguity now terminates the
  phase rather than giving the aider-text loop a chance to recover. This
  trade favors CORRECTNESS (never silently reproducing the dangling-body
  defect) over AVAILABILITY (always making forward progress via some path).
  If this proves too strict in practice (e.g. legitimate ambiguous-anchor
  cases the text loop could actually resolve), the fix is to narrow the
  detection further, not to relax the hard-abort itself.
- **`attributePhaseFailure` caveat:** `phase-runner.ts`'s failure-attribution
  logic may reattribute the TOP-LEVEL error message surfaced to the
  coordinator/production caller for other diagnostic purposes, even though
  the step-level abort message constructed in `verified-implement-step.ts` is
  itself honest and specific. Anyone debugging a production `anchor-unexpandable`
  hard-abort should look at the `--verbose` `structured-aborted` progress line
  (which carries the original `AnchorExpansionError.message` verbatim as
  `detail`), not just the top-level phase-failure message, if the two ever
  appear to diverge.
- `simulatePartialEdits`'s single-occurrence-match requirement means a
  partial edit whose `search` appears zero or multiple times in the current
  predicted content still leaves the prediction un-updated for that edit —
  an inherited, deliberately out-of-scope limitation shared conceptually with
  `coerceCreatesToEdits`'s own documented gap.
