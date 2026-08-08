# ADR 0002: Deterministic structured create→edit coercion for existing files

## Status

**Accepted, implementation complete. PROVISIONAL pending live re-verification (see Verification gate below).**

## Context

The structured whole-phase patch path (`tryStructuredPhase` in
`structured-implement.ts`) is unstable when the model's ops touch a file
that ALREADY EXISTS on disk — most commonly because an earlier `move` op in
the same phase relocated it there. Two symptoms were observed run-to-run on
the same target file (a parlang member `Cargo.toml` relocated by a Step-1
directory MOVE):

- **Symptom A (additive/malformed edit).** The model emitted an `edit` op
  whose `search` anchor was narrower than the region it intended to
  replace, so the applier's faithful `search`/`replace` substitution left
  stale content dangling alongside new content — in the observed case, a
  malformed `[lints]` table that `cargo` silently tolerated (a
  weak-assertion loophole, not a build failure), producing a false-green
  commit.
- **Symptom B (create-over-existing).** The model emitted a `create` op for
  the already-existing path. `applyPatch`'s create branch declined with
  `"already exists; cannot create"`, forcing a fallback to the incremental
  aider-text repair loop — the exact flaky path this structured mechanism
  exists to avoid.

Root cause: `patchOpsToEdits` (the only normalization between the model's
raw ops and the applier) is deliberately filesystem-blind, so nothing
between the model and the applier knew the target file's on-disk state; and
the structured path forwarded NO system prompt to the model at all, unlike
the aider-text path (which passes `implementSystem`/`buildPatchSystem`).

## Decision

Two defense-in-depth mitigations, landed in dependency order (deterministic
fix first, prompt lever second, so no intermediate commit ships a
runtime-behavior change without its safety net):

1. **Applier empty-file relaxation** (`apply-patch-step.ts`): a `create` op
   targeting an existing, EMPTY (0-byte) file now overwrites it instead of
   declining — an empty file has no content to conflict with.
2. **`coerceCreatesToEdits`** (`coerce-create-to-edit.ts`): a new,
   deliberately filesystem-aware normalization pass, inserted between
   `patchOpsToEdits` and `applyEditsTransactionally` inside
   `tryStructuredPhase`. A `create` targeting an existing, NON-empty file
   with contents different from the create's own contents is coerced into a
   whole-file-replace `edit` (`search` = entire current contents, `replace`
   = the create's contents) — guaranteed to match exactly once (a string
   cannot contain two non-overlapping copies of its own entirety), so the
   applier's edit branch applies it cleanly. This deterministically closes
   **Symptom B**. Byte-identical creates and out-of-workspace paths pass
   through unchanged; `assertInsideWorkspace` remains the sole path-safety
   gate, and the coercion never itself performs path-safety checks or reads
   outside the workspace.
3. **`STRUCTURED_PATCH_SYSTEM`** (`patch-guidance.ts`): a provider-agnostic
   system prompt now forwarded from `tryStructuredPhase` to
   `orchestratePatch` via `LLMOptions.system`, applied to ALL
   structured-capable providers (Anthropic, Copilot). It instructs the
   model to use `edit` for existing files, `create` only for genuinely new
   files, and to make an `edit`'s `search` cover the entire region being
   replaced.

## Rejected alternative

Building a TOML/manifest structural validator (or a generic "does this edit
look additive" heuristic) directly into this normalization layer to close
**Symptom A** deterministically. Rejected because a generic heuristic (e.g.
"reject an edit whose `replace` still contains `search`") would
false-positive on legitimate edits that intentionally retain part of their
`search` text inside `replace`, which is worse — in an unattended pipeline
— than the malformed-output case it would guard against. Manifest/structural
output validity is a distinct, well-scoped problem with its own dedicated
plan: **`plan:false-green-gate-assert-v1`** (structural/manifest assertion
vocabulary in the plan-runner's green gate). Ownership of Symptom A is
explicitly assigned there, not here.

## Consequences

- **Symptom B (create-over-existing) is deterministically resolved.** No
  run-to-run flip between "additive edit" and "create-over-existing"
  remains possible for this failure mode — the coercion always converts it
  to a clean edit.
- **Symptom A (additive/malformed edit) has NO deterministic guard here.**
  `STRUCTURED_PATCH_SYSTEM` mitigates it via prompt guidance only; a model
  that ignores the guidance can still produce a malformed-but-tolerated
  result, and this normalization layer will not catch it. This residual
  false-green risk is intentional and explicitly deferred to
  `plan:false-green-gate-assert-v1`.
- **Mirror gap (out of scope).** An `edit` op targeting a MISSING file still
  declines with a `not-found` error (unchanged behavior) — no analogous
  edit→create coercion exists in the other direction. Noted here as a known
  gap, not addressed.
- **Invariants preserved.** `assertInsideWorkspace` remains the sole
  path-safety gate; the aider-text fallback is unchanged; `PatchMode`
  defaults are unchanged; the transactional apply/rollback path fully
  covers coerced edits (coercion runs before `applyEditsTransactionally`).

## Verification gate

The green unit test suite (including a replay/fixture test that feeds a
canned create-over-existing ops payload through the full
`tryStructuredPhase` path) proves the coercion **wiring** is correct. It
does **not** prove that Copilot's live forced-tool `emit_patch` path still
adheres to the tool schema once a system prompt is present — Copilot's
structured path was previously live-verified working with **NO** system
prompt (cerebrum findings `d5b46862`, `497dec30`), and Copilot's WAF-sensitive,
forced-tool-call proxy behavior is exactly the kind of surface where an
added system message could change tool-call adherence.

**This change is PROVISIONAL until a human/coordinator re-runs the live
`copilot-default` structured plan-cycle (e.g. the parlang Phase-0 test loop)
and confirms the forced-tool `emit_patch` path still fires and applies
correctly WITH `STRUCTURED_PATCH_SYSTEM` present** — no dispatch
regression, no tool-adherence loss. Until that re-verification happens, do
not treat this ADR's "Accepted" status as a substitute for live confirmation
on the Copilot path specifically.

## Cross-references

- `plan:false-green-gate-assert-v1` — owns the deferred Symptom-A
  (manifest/structural validity) fix.
- Cerebrum findings `151af9e0` (create-over-existing apply-failed run),
  `c6f0e184`/`3c247d88` (malformed-`[lints]` false-green run + diagnosis),
  `a9bcc163` (the create-vs-edit expressibility gotcha), `afa940e7`
  (green-gate enforcement spec), `d5b46862`/`497dec30` (Copilot structured
  path live-verified with no system prompt).
- `plan:parlang-phase0` — the test-loop plan whose Step 2 member-manifest
  edit originally exposed this instability.
