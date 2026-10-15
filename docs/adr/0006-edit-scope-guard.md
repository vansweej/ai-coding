# ADR 0006: Conservative edit-scope guard against silent line destruction

## Status

Accepted, implementation complete.

## Context

A live plan-cycle run applied a structured patch whose REPLACE body dropped the
non-ASCII doc line `/// Type scheme for polymorphic types: ∀α.τ` present in its
SEARCH anchor and substituted an invented `/// placeholder_marker_removed`. The
surrounding lines were intact, so the anchor matched and `applyPatch` wrote the
destructive edit with no signal. A related mode is weak models emitting elision
placeholders such as `// ... existing code ...` inside REPLACE, collapsing real
content. A third mode, introduced by P2's retry file context, is a model echoing
the `[ai-coding: truncated N chars]` prompt-context marker into a REPLACE body,
overwriting the truncated tail with the marker text. Neither `parsePatch` nor
`applyPatch` guarded against a REPLACE that silently destroys SEARCH content,
because both treat REPLACE as opaque bytes.

## Decision

Add a pure module `edit-scope-guard.ts` exporting
`checkEditScope(search, replace, filePath): Result<void, EditScopeViolation>`,
invoked as a single all-or-nothing PRE-PASS at the top of `applyPatch` (before
any edit is written) over every modification edit — not a move, not a create. A
pre-pass, rather than a per-splice-site guard, keeps a single call site and
guarantees the non-transactional text loop never leaves a partially-applied
batch when a later edit is rejected. Raw `edit.search`/`edit.replace` are used
because they reflect the model's intent; table-anchor expansion adds identical
rows to both sides and cannot change the verdict.

Three conservative rules, tuned for zero/near-zero false positives:

- **R1 elision placeholder** — REPLACE introduces a comment line absent from
  SEARCH whose BODY essentially IS the placeholder: ellipsis-only/-bounded, or an
  anchored elision phrase (`existing code`, `rest of (the )? file/code/function/
  implementation/class/module`, `(code|content) remains/stays unchanged/the
  same`, `unchanged`, `same as before`, `(omitted|elided) for brevity`). The
  patterns are anchored at the comment-body start so an ordinary comment that
  merely MENTIONS such a phrase mid-sentence (e.g. `// refactor existing code
  paths`, `// behaviour is unchanged when x is null`) is NOT a violation. Comment
  detection excludes C/Rust deref `*ptr` lines (a `*` prefix counts only when
  bare, before a space, or `/`) and Rust attributes `#[...]` / `#![...]`.
- **R2 non-ASCII substitution** — a SEARCH COMMENT line containing non-ASCII
  characters is DROPPED (no trim-equal REPLACE line AND none of its non-ASCII
  characters appear anywhere in REPLACE) AND REPLACE introduces a new comment
  line of the SAME comment-token FAMILY. Comment tokens are compared by FAMILY,
  not exact prefix: the `//` family covers `//`, `///`, `//!`; the block family
  covers `/*`, `/**`, `*`, `*/`; and `#`, `--`, `<!--` are each their own
  family. This is the substitution shape of the live incident (`///` → `///`,
  and also `///` → `//`, both in the `//` family). Plain deletions of non-ASCII
  lines, rewrites of non-ASCII code lines (`const s = "café";` →
  `const s = "cafe";`), and rewrites of a non-ASCII comment into a
  DIFFERENT-family comment (`# a — b` → `// a b`) are all allowed. Rewriting a
  non-ASCII comment into a same-family comment IS treated as a substitution and
  flagged; the env opt-out covers rare legitimate cases.
- **R3 truncation-marker echo** — REPLACE contains the prompt-context marker
  `[ai-coding: truncated` while SEARCH does not.

R1 and R2 are skipped for prose files (`.md`, `.mdx`, `.markdown`, `.txt`),
where a `## Unchanged` heading or a `---` rule is legitimate content; R3 applies
everywhere because the truncation marker is never legitimate file content. The
whole pre-pass is disabled when the `AI_CODING_EDIT_SCOPE_GUARD` environment
variable is set to `off` (trimmed, lowercased).

A violation surfaces as `PatchApplyError` with the new `reason: "scope-violation"`.

## Consequences

- Silent substitution of documented non-ASCII content, elided whole sections,
  and echoed truncated tails are caught at apply time and fed back for
  correction, never silently committed.
- Because the guard is an all-or-nothing pre-pass, a rejected multi-edit patch
  leaves the working tree untouched in the text loop; no partial write survives.
- In the text loop the violation is retryable via `PATCH_RESPONSE_ERROR_NAMES`;
  on the structured path it maps to an `apply-failed` decline that falls back to
  the text loop (including under `--strict`). It is never fast-failed as a logic
  error. If the model keeps producing violating patches the phase can still
  exhaust its retries — that is the scenario the `AI_CODING_EDIT_SCOPE_GUARD=off`
  opt-out is for.
- Known trade-off: a near-miss SEARCH/MOVE block marker (`<<<<<<< SEARCH:`,
  `<<<<<<<SEARCH`) now produces the prose-only reply message (which shows the
  exact required format) rather than the per-file marker hint.
- The rules are intentionally narrow; moving a non-ASCII line, deleting a
  non-ASCII comment outright, rewriting a comment with genuinely new prose or a
  different comment-token family, deleting ASCII comments, and ordinary prose
  comments that mention elision words all pass. Future rule additions must
  preserve the zero-false-positive bias.
