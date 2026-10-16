# 0008 — Dispatch timeouts and fixer escalation

## Status

Status: Accepted

## Context

Cloud and local model dispatches could hang indefinitely, and a dispatcher
that ignores an abort signal must not stall a plan-cycle run. The `fixer` role
also needs a stronger model when local retries are exhausted.

## Decision

Wrap every dispatch attempt in the central `withAbortableDeadline`, which has a
deadline backstop and passes an `AbortSignal` through every dispatcher. Support
the `AI_CODING_DISPATCH_TIMEOUT_SECONDS` override and await full-jitter backoff
before the single transient retry. Classify Copilot `finish_reason` values:
`content_filter` becomes the logic-fail-fast `ContentFilterError`, while
`length` becomes retryable `OutputTruncatedError`. Route the `fixer` role to
`copilot/claude-sonnet-5.5` through its text dispatch path only; do not add it
to `patch-capability.ts`.

## Consequences

Slow but healthy completions survive, while hung dispatches fail transiently
even if a dispatcher ignores the abort signal. Truncated outputs retry with a
larger budget. Under `--strict`, a structured-patch timeout surfaces as a
`dispatch-error` decline and hard-fails; previously, that dispatch would hang.
