# ADR 0005: Hardened, language-agnostic tolerant anchor matching for structured-patch EDIT ops

## Status

Accepted, implementation complete.

## Context

ADR 0004 closed the predicted-vs-disk divergence class for table-header
rename anchors, but a live parlang-phase0-v2 run (recorded in cerebrum under
the search handle "structured search anchor not found lints") surfaced a
DIFFERENT root cause for the same symptom (`applyPatch` returning `{ ok:
false, reason: "not-found" }` on an EDIT op). With `ANCHOR_DEBUG=1`
instrumentation added at the `searchCount===0` branch of `apply-patch-step.ts`,
the captured bytes proved the table expander was correctly not firing (the
model's `search` is a multi-line block, not a bare header) and that the
entire mismatch was two `#` comment lines physically present on disk but
dropped by the model's paraphrased `search`:

Model `search` (verbatim):

```
[lints.clippy]
pedantic = { level = "warn", priority = -1 }
module_name_repetitions = "allow"
must_use_candidate = "allow"
```

Actual on-disk `[lints.clippy]` block:

```
[lints.clippy]
# Enforce stricter linting for better code quality
pedantic = { level = "warn", priority = -1 }
# Allow some pedantic lints that are too strict for this project
module_name_repetitions = "allow"
must_use_candidate = "allow"
```

Exact-string search therefore fails, the structured path declines with
`apply-failed`, and the caller falls back to the incremental aider-text loop
— which then died on an unrelated `` ``` `` fence-pollution parser bug,
aborting the phase with no commit. This is the fifth time in this project's
history that a variant of this "search anchor not found" symptom has been
chased and (mis)fixed; the first four fixes (see ADR 0004 and its
cross-referenced cerebrum findings) each targeted a plausible but wrong
mechanism and did not resolve the underlying paraphrase-recovery gap.

### Why the first drafted guards were illusory

An early draft of this fix (rejected during a sparring round before
implementation) proposed a "tolerant" matcher whose safety rested on three
guards that turned out to be illusory when reproduced against the historical
dangling-following-table shape:

- **Count-only absorption bound** ("extras absorbed must not exceed
  `anchorLines.length`"): this bounds *how much* can be skipped, not *where*
  it is skipped to. It does nothing to stop a walk from crossing a blank line
  into an entirely unrelated, blank-separated block if the count budget
  allows it — which it usually does for short anchors.
- **Tautological end-point guard** ("the anchor's last line must match"):
  by construction, any completed walk necessarily ends where the last line
  matched — asserting this after the fact proves nothing about whether that
  match was the ONLY valid completion, or the correct one.
- **Trim-away-indentation normalization**: comparing lines with `.trim()`
  makes indentation invisible to the matcher, which is unsafe for
  indentation-significant languages (Haskell, Python) explicitly on this
  project's near-term language roadmap (Rust today; Ruby-on-Rails and
  Haskell imminent).

Each of these maps to a REAL risk the hardened design below closes:

| Illusory guard | Real risk | Hardened replacement |
|---|---|---|
| Count-only bound | Overshoot into a following blank-separated table/block | Blank-line boundary (authoritative) |
| Tautological end-point check | Silently picking the wrong (or an ambiguous) end position | Real end-point ambiguity abort |
| Trim-based normalization | Wrong indentation silently written back in Haskell/Python | Indentation-preserving normalization |

## Decision

Add a new, PURE, side-effect-free, language-agnostic helper module,
`ai-system/core/pipeline/steps/tolerant-anchor-match.ts`, exporting:

```ts
export function matchTolerantAnchor(
  content: string,
  search: string,
): Result<{ startOffset: number; endOffset: number }, { reason: "not-found" | "ambiguous" }>
```

It hardcodes no comment tokens for any language (no `//`, `#`, `--`, `{-`,
`-}` literals appear anywhere in the module) — the recovery mechanism is
universal: a model-paraphrased anchor may drop interleaved lines physically
present on disk, and the safe boundary for how far a recovery walk may
extend is the blank line, which every language treats as an insignificant
separator.

**Algorithm, and how each guard maps to the risk it closes:**

1. **Blank-line boundary (primary, authoritative guard).** A matched region
   may never cross a normalized-blank content line (a line whose comparison
   key has an empty collapsed remainder). This directly replaces the useless
   count-only bound and is what stops the historical dangling-following-table
   overshoot: the following `[lints.rust]` table, separated by a blank line,
   is structurally unreachable by any candidate walk.
2. **Real end-point ambiguity abort.** After the penultimate anchor line is
   matched, the matcher scans ALL positions at/after that point (within the
   same non-blank run, before any boundary blank) where the anchor's LAST
   line also matches. If more than one such position exists, the start is
   rejected as ambiguous rather than silently choosing the first (or last)
   candidate end. This closes the tautological-guard risk: wrong end
   selection is now impossible to reach un-flagged.
3. **Indentation-preserving normalization.** `normalizeLine` splits each line
   into a `(leadingWhitespace, collapsedRemainder)` pair. Leading whitespace
   is part of the comparison key and is compared STRICTLY — never
   `.trim()`-ed. Only internal/inter-token whitespace runs collapse to a
   single space. This is the documented residual: a string literal such as
   `"a    b"` compares equal to `"a b"`, an accepted trade-off; indentation
   strictness is the guaranteed invariant, and is what makes this matcher
   safe to use ahead of the imminent Haskell and Python toolchains.
4. **Region-based (not just start-index) uniqueness.** Zero completed
   regions across all candidate starts → `not-found`. More than one
   completed region (whether from one start via end-point ambiguity, or from
   more than one distinct start) → `ambiguous`. Exactly one → success.
5. **Raw-search invariant.** The tolerant matcher is invoked (from
   `apply-patch-step.ts`) against the RAW `edit.search`, never the
   table-expander's `effectiveEdit.search` (ADR 0004). This avoids stacking
   two independent paraphrase-recovery mechanisms on the same TOML-table
   anchor shape, which would make failures far harder to diagnose.
6. **Splice by offsets, never `String.replace`.** `matchTolerantAnchor`
   returns only `{ startOffset, endOffset }`; the caller splices
   `content.slice(0, startOffset) + edit.replace + content.slice(endOffset)`.
   A paraphrased anchor will not byte-match `edit.search`, so
   `String.prototype.replace` cannot be used for the tolerant path.

**Wiring:** `ApplyPatchOptions` gained a new `tolerantAnchorMatch?: boolean`
flag (default `false`). In the `searchCount===0` branch of `applyPatch`, when
the flag is set, `matchTolerantAnchor(currentContent, edit.search)` is tried
BEFORE declaring the anchor unrecoverable. On success, the spliced content is
written and the batch continues. On an `ambiguous` decline, the existing
`ambiguous` `PatchApplyError` reason is reused (no new reason invented). On a
`not-found` decline, the existing `"Search anchor not found"` error is
returned unchanged. Only `structured-implement.ts`'s
`applyEditsTransactionally` opts in (`{ expandTableAnchors: true,
tolerantAnchorMatch: true }` at both `applyPatch` call sites); the
`verified-implement-step.ts` incremental aider-text retry loop passes no
options and is completely unaffected.

**Per-iteration fresh-read invariant.** The tolerant matcher is called
against `currentContent`, which is read fresh from disk on EVERY loop
iteration for the current edit. The returned offsets are valid ONLY against
that specific read. Hoisting the read out of the loop (e.g. to read the file
once up front for a whole batch) would corrupt multi-edit-same-file batches,
because earlier edits in the same batch mutate the file between iterations.

**Retained diagnostic.** The `ANCHOR_DEBUG=1`-gated stderr dump added to
`apply-patch-step.ts` while root-causing this bug (raw vs. effective anchor,
on-disk bytes, and now also the tolerant-match outcome fields: whether
`tolerantAnchorMatch` was enabled and its result reason) is a DELIBERATE,
PERMANENT diagnostic — not a temporary probe to be reverted. It is retained
for future anchor-mismatch investigations, remains inert unless
`ANCHOR_DEBUG=1` is set, is Biome-clean, and is excluded from coverage via
`/* v8 ignore */` (a stderr-only side effect with no return-value effect). It
now fires on the FINAL failure path only — after the tolerant matcher (if
attempted) has also declined, including on an `ambiguous` decline, so an
ambiguous rejection is equally diagnosable.

## Consequences

**Easier / more robust:**

- Paraphrased EDIT anchors that merely drop interleaved lines physically
  present on disk (comments in any language, or other incidental lines) are
  now recoverable without falling back to the aider-text loop, which is both
  less reliable (chatty-text-pollution parsing bugs) and loses the
  transactional apply/rollback guarantees of the structured path.
- The recovery mechanism is provably language-agnostic (tested against `#`,
  `//`, `--`, and `{- -}` comment shapes, none hardcoded) and fails closed on
  indentation drift, so it is safe to enable ahead of the Haskell and
  Ruby-on-Rails toolchains without re-litigating this design.
- The structured path's transactional apply/rollback and `anchor-unexpandable`
  hard-abort semantics (ADR 0003/0004) are unaffected — the tolerant matcher
  only engages after the table expander and exact search have both declined.

**Harder / follow-up work (explicitly out of scope for this ADR):**

- (a) The aider-text loop's SEARCH/REPLACE parser dying on `` ``` `` triple-
  fence pollution ("File ``` is missing <<<<<<< SEARCH marker") is a second,
  independent bug observed in the same field run. It is NOT addressed here.
- (b) The short-anchor / exact-match-at-a-single-WRONG-location false-green
  subclass (`searchCount===1` matching a unique but semantically WRONG
  location in the file) is a structurally different failure mode — this fix
  only addresses the `searchCount===0` (paraphrase) subclass, and does not
  attempt to detect or reject a confidently-wrong single match.
