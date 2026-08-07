/**
 * Per-model structured-patch capability registry.
 *
 * A `PatchMode` describes HOW a model backend can guarantee valid structured
 * patch output (if at all). Keyed by the bare model-ID string that indexes
 * `config.dispatchers` (see model-profiles.ts) -- NOT by profile and NOT by
 * role -- because `HYBRID_PROFILE` mixes providers per-role, and the same
 * profile's `implementer` and `fixer` roles can resolve to different
 * model-IDs with different capabilities. Capability must be resolved fresh,
 * per attempt, from the action-resolved model-ID (see `orchestratePatch` in
 * ./orchestrate.ts) -- never cached or computed once up front.
 *
 * Default is always "text": every model not explicitly registered here
 * keeps using the existing aider-text + parsePatch path, unchanged.
 */
export type PatchMode = "text" | "anthropic-tool-use" | "openai-tool-calls";

/**
 * Registry of model-IDs opted into a structured PatchMode.
 *
 * - "claude-sonnet-5" (Anthropic-native) -> "anthropic-tool-use" (Plan A).
 * - "copilot/claude-sonnet-5" and "claude-sonnet-4.6" (both Copilot-served
 *   per model-profiles.ts -- COPILOT_DEFAULT_PROFILE and HYBRID_PROFILE
 *   respectively) -> "openai-tool-calls" (Plan B; empirically confirmed
 *   against live Copilot, see docs/adr/0001-copilot-structured-patch.md).
 *
 * Local/Zen models ("constrained-json") are added in Plan C -- do not add
 * them here.
 */
const PATCH_MODE_BY_MODEL: Readonly<Record<string, PatchMode>> = {
  "claude-sonnet-5": "anthropic-tool-use",
  "copilot/claude-sonnet-5": "openai-tool-calls",
  "claude-sonnet-4.6": "openai-tool-calls",
};

/**
 * Resolve the structured-patch capability for a bare model-ID string.
 * Defaults to `"text"` for any model not explicitly registered, so every
 * existing model's behavior is unchanged until explicitly opted in.
 *
 * @param model - The bare model-ID string that indexes `config.dispatchers`.
 */
export function patchModeForModel(model: string): PatchMode {
  return PATCH_MODE_BY_MODEL[model] ?? "text";
}
