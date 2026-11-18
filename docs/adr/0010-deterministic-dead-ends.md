# ADR 0010: Deterministic dead ends and scoped assertions

## Status

Status: Accepted

## Context

Repeated edit-scope violations and prose responses after failed verification can consume retries
without advancing a phase. Gate diagnostics can obscure the first test failure when stderr contains
only a generic summary. Exact `contains` assertions also fail on harmless whitespace changes, and
Rust files with in-file test modules need assertions scoped to production code.

## Decision

Stop early with `planGuardConflict` after two consecutive identical R2 non-ASCII scope-violation
messages, or with `proseAfterRed` when a prose-only reply follows verification that remains red on
recheck. Both stops skip the remaining local and escalation attempts. Exempt an R2 comment rewrite
when the phase's step bodies contain the dropped non-ASCII comment and every newly introduced
same-family comment line verbatim.

Lead failed shell-step diagnostics with a first-failure summary when one can be extracted, and
include a bounded stdout tail when both output streams are present. Make `contains`
whitespace-tolerant with a closest-line failure hint, while keeping `not-contains` exact. Add
`not-contains-outside-tests` to check only the region before the first trimmed `#[cfg(test)]` line
(or the whole file when absent).

## Consequences

Deterministic dead ends stop without burning the remaining repair budget, and explicitly planned
non-ASCII rewrites can pass the guard. Diagnostics and assertions are more useful without
tightening the existing negative substring check. Phase failures retain resumable exit code 2;
exit codes remain unchanged because choragos retries anything other than 0 or 3.
