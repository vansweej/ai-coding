# ADR 0009: Preflight validation and commit-message normalization

## Status

Status: Accepted

## Context

Delimiter-wrapped commit subjects (backtick- or quote-wrapped `Commit message:` values) leaked
verbatim into git history because `commitPhaseChanges` passes the parsed message straight to
`git commit -m`. Separately, plan defects such as an `Assert:` path that no step creates only
surfaced after a phase had already spent tokens, because nothing validated the plan statically
before dispatch.

## Decision

Normalize commit messages at the parser (the single source of truth feeding `git commit`): strip
one surrounding matching delimiter pair and re-trim; an empty result is a parse error. Add a pure,
I/O-free preflight module run before any dispatch with four rules:

- `assert-path-missing` (error; aborts the run)
- `commit-message-normalized` (warn)
- `anchor-ellipsis` (warn)
- `step-without-edit-target` (warn)

Three rules from an earlier draft were dropped: `coverage-undeclared` (the `Coverage:` directive
is inert for TypeScript workspaces and would warn on nearly every plan), `assert-test-unpaired`
(obsolete now that the `Assert: test` verb itself fails on zero executed tests), and
`anchor-non-ascii` (exact non-ASCII bytes in anchors are legitimate, e.g. glyph maps and em
dashes).

## Consequences

Preflight errors exit 3 before any model dispatch or working-tree mutation, catching plan defects
token-free. A plan that creates a file must name its path in a step, or an Assert on that file
aborts the run. Under `--strict`, warnings are promoted to errors and also abort. Wrapped commit
subjects can no longer reach git history.
