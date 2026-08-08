/**
 * Provider-agnostic system-prompt guidance for the structured whole-phase
 * patch path (`tryStructuredPhase` in
 * ../pipeline/steps/structured-implement.ts).
 *
 * The structured path previously forwarded NO system prompt at all to the
 * model (unlike the aider-text path, which passes `implementSystem` via
 * `buildPatchSystem` in ../pipeline/definitions/language-configs.ts). This
 * left the model with no guidance on when to emit a `create` op versus an
 * `edit` op, and no instruction that an `edit`'s `search` must cover the
 * entire region being replaced -- contributing to two observed failure
 * modes: a `create` emitted for a file that already exists (declined by the
 * applier and falling back to the text loop), and an additive `edit` whose
 * `search` was too narrow, leaving stale content dangling alongside new
 * content.
 *
 * This guidance MITIGATES both, but is not a deterministic guard on its
 * own -- the deterministic fix for the create-over-existing case is
 * `coerceCreatesToEdits` (../pipeline/steps/coerce-create-to-edit.ts), which
 * runs regardless of whether the model follows this guidance. The
 * additive/malformed-edit failure mode has no deterministic applier-level
 * guard here; see docs/adr for the residual risk and its owner
 * (`plan:false-green-gate-assert-v1`).
 *
 * Applied to ALL structured-capable providers (Anthropic, Copilot) via
 * `orchestratePatch`'s `llmOptions.system` -- see structured-implement.ts.
 */
export const STRUCTURED_PATCH_SYSTEM =
  "You are emitting a structured whole-phase patch as a single tool call. " +
  "Use an `edit` operation for a file that already exists. Use a `create` " +
  "operation ONLY for a genuinely new file that does not yet exist. When " +
  "you emit an `edit`, its `search` field MUST include the ENTIRE " +
  "contiguous region being replaced, so the old content is fully removed " +
  "rather than left dangling alongside the new content.";
