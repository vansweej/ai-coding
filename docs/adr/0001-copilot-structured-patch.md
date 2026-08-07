# ADR 0001: Copilot structured patch support (empirical probe result)

## Status

**PASS — Phase 2 (CopilotDispatcher.dispatchPatch) proceeds.**

## Context

The structured whole-phase patch output contract (see
`docs/plan-structured-patch-a.md`) was proven against the Anthropic-native
`tool_use` mechanism in Plan A. Plan B's open question was whether GitHub
Copilot's `chat/completions` proxy would honor a forced OpenAI-shaped
`tools`/`tool_choice` request using our `PATCH_OPS_JSON_SCHEMA` as the
function's `parameters`, given that Copilot is served through an unofficial
direct-token-passthrough auth path (see `copilot-dispatcher.ts` for the
auth details) rather than an officially documented API surface.

## Probe

Ran `scripts/probe-copilot-toolcalls.ts` against the live Copilot
`chat/completions` endpoint using the durable `GITHUB_COPILOT_TOKEN` sent
directly as the Bearer credential (the same auth path `CopilotDispatcher`
uses), with `model: "claude-sonnet-4.6"`, a forced `tool_choice` naming
`emit_patch`, and `PATCH_OPS_JSON_SCHEMA` as the function's `parameters`.

**Result: HTTP 200.** The response's `choices[0].message.tool_calls[0]` was
present, named `emit_patch`, and its `arguments` field was a JSON string:

```json
{"ops":[{"kind":"create","filePath":"hello.ts","contents":"export const hello = \"world\";"}]}
```

This string parsed via `JSON.parse` and then validated cleanly through
`parsePatchOps`, producing a schema-valid `PatchOp[]`.

## Decision

**PASS.** Copilot's proxy reliably returns a well-formed `arguments` JSON
string that parses to our schema when `tool_choice` forces the `emit_patch`
function. Plan B Phase 2 (implement `CopilotDispatcher.dispatchPatch` and
register the Copilot model-IDs as `"openai-tool-calls"` in the capability
registry) proceeds.

## Contingency (not triggered)

Had the probe failed — no `tool_calls` in the response, malformed/non-JSON
`arguments`, or a schema-violating parsed object — Copilot would have
stayed permanently in `"text"`-default mode, and Plan B Phase 2/3 would
have been abandoned. That branch does not apply here.

## Caveats

- Tested against `claude-sonnet-4.6` (the model-ID Copilot serves under
  `HYBRID_PROFILE`/`COPILOT_DEFAULT_PROFILE`'s namespaced
  `copilot/claude-sonnet-5`). The exact model-ID(s) to register in
  `patch-capability.ts` should be confirmed against current
  `model-profiles.ts` routing at implementation time.
- This is an empirical result against Copilot's *current* proxy behavior.
  Copilot is served through an unofficial, reverse-engineered auth path
  (see `copilot-dispatcher.ts` comments) that could change without notice;
  re-verify if `CopilotDispatcher.dispatchPatch` starts failing in
  production.
