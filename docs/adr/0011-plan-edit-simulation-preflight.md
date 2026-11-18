# ADR 0011: Plan edit simulation preflight

## Status

Status: Accepted

## Context

Drifted or ambiguous OLD anchors and edit-scope guard conflicts can otherwise surface only after
model dispatch. Fragile or unsourced assertion needles can likewise cause verification failures
after tokens have been spent.

## Decision

Add a pure, zero-token simulation module that extracts OLD/NEW edit pairs and replays them in plan
order over a virtual file map seeded by an injected `readFile`. Preflight surfaces the following
rules at WARN severity:

- `anchor-not-found`
- `anchor-not-unique`
- `plan-conflicts-with-guard`
- `fragile-assert`
- `assert-needle-unsourced`

## Consequences

Drifted or ambiguous anchors can be caught before tokens are spent. Warnings do not abort unless
`--strict` promotes them to errors. Simulation does not prove that the edits compile. Full B4,
applying each phase in a scratch worktree and running its toolchain gates, is explicitly deferred.
