# 0007 — Retry discipline: best-so-far revert and convergence detection

## Status

Status: Accepted

## Context

The text retry loop accumulates changes on a dirty tree with no reset between
attempts, so an attempt that regresses to an earlier verification gate can bury
a near-passing one. Identical repeated failures also waste the local retry
budget.

## Decision

Introduce pure `verification-failure`/`progress-score`/`convergence` modules
and an impure `best-so-far` module. Each failing verification attempt is scored
by the index of its first failing gate only; diagnostic-line tie-breaks were
deliberately dropped as noise. The verified-implement step keeps the most
recent non-regressed tree, reverts to it when a later attempt fails at an
earlier gate, and escalates early on two consecutive identical fingerprints.
New `revert-to-best`/`convergence` progress events fire only on failure paths.
The revert leaves the real git index at HEAD, so best-only files reappear
untracked, and preserves `plans/` and the active plan path.

## Consequences

Greener resumes, honest local-attempt counts after convergence, silent no-op on
non-git test workspaces, and palette gate-list variation handled as
`incomparable`.
