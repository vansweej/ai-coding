/**
 * Model roles and named profiles for the AI Coding OS pipeline.
 *
 * A role is a semantic label for what a pipeline step does.
 * A profile is a named configuration mapping each role to a concrete model ID.
 *
 * Resolution flow:
 *   pipeline step → ModelRole → ModelProfile → model ID → dispatcher
 */

/** Semantic role a pipeline step plays. */
export type ModelRole =
  | "planner"
  | "implementer"
  | "debugger"
  | "fixer"
  | "reviewer"
  | "tester"
  | "scaffolder"
  | "explorer"
  | "default";

/** Named profile: maps every role to a concrete model ID. */
export interface ModelProfile {
  readonly name: string;
  /** Maps each role to the model ID string used for dispatcher lookup. */
  readonly roles: Readonly<Record<ModelRole, string>>;
}

/** Fully-local profile: every role runs on the local Ollama model. No Copilot token required. */
export const LOCAL_PROFILE: ModelProfile = {
  name: "local",
  roles: {
    planner: "gemma4:26b",
    implementer: "gemma4:26b",
    debugger: "gemma4:26b",
    fixer: "gemma4:26b",
    reviewer: "gemma4:26b",
    tester: "gemma4:26b",
    scaffolder: "gemma4:26b",
    explorer: "gemma4:26b",
    default: "gemma4:26b",
  },
};

/** All roles route to GitHub Copilot Claude Sonnet 4.6. */
export const COPILOT_DEFAULT_PROFILE: ModelProfile = {
  name: "copilot-default",
  roles: {
    planner: "claude-sonnet-4.6",
    implementer: "claude-sonnet-4.6",
    debugger: "claude-sonnet-4.6",
    fixer: "claude-sonnet-4.6",
    reviewer: "claude-sonnet-4.6",
    tester: "claude-sonnet-4.6",
    scaffolder: "claude-sonnet-4.6",
    explorer: "claude-sonnet-4.6",
    default: "claude-sonnet-4.6",
  },
};

/** Hybrid profile: local Ollama for normal implementation, Copilot for escalation. */
export const HYBRID_PROFILE: ModelProfile = {
  name: "hybrid",
  roles: {
    planner: "claude-sonnet-4.6",
    implementer: "gemma4:26b",
    debugger: "gemma4:26b",
    fixer: "claude-sonnet-4.6",
    reviewer: "claude-sonnet-4.6",
    tester: "gemma4:26b",
    scaffolder: "claude-sonnet-4.6",
    explorer: "claude-sonnet-4.6",
    default: "claude-sonnet-4.6",
  },
};

/**
 * All roles route to Anthropic Claude Sonnet 5 via the native Anthropic Messages API.
 *
 * Design principle -- the profile is the single source of truth. Per-role
 * provider selection is expressed only through profile definitions; there is
 * no separate model-override flag. Because the `dispatchers` map is
 * provider-agnostic (built in load-config.ts by binding each model-ID string
 * to its dispatcher), any role in any current or future profile selects its
 * provider purely by which model-ID string it maps to (e.g. "claude-sonnet-5"
 * -> Anthropic, "claude-sonnet-4.6" -> Copilot, "gemma4:26b" -> Ollama).
 * Adding a new provider mix later is pure data: define another ModelProfile
 * constant and register it below -- no routing, CLI, or wiring changes required.
 */
export const ANTHROPIC_SONNET_PROFILE: ModelProfile = {
  name: "anthropic-sonnet",
  roles: {
    planner: "claude-sonnet-5",
    implementer: "claude-sonnet-5",
    debugger: "claude-sonnet-5",
    fixer: "claude-sonnet-5",
    reviewer: "claude-sonnet-5",
    tester: "claude-sonnet-5",
    scaffolder: "claude-sonnet-5",
    explorer: "claude-sonnet-5",
    default: "claude-sonnet-5",
  },
};

/** Registry of all built-in profiles, keyed by profile name. */
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = {
  [LOCAL_PROFILE.name]: LOCAL_PROFILE,
  [COPILOT_DEFAULT_PROFILE.name]: COPILOT_DEFAULT_PROFILE,
  [HYBRID_PROFILE.name]: HYBRID_PROFILE,
  [ANTHROPIC_SONNET_PROFILE.name]: ANTHROPIC_SONNET_PROFILE,
};

/** The profile name used when no explicit profile is requested. */
export const DEFAULT_PROFILE_NAME = "copilot-default";

/**
 * Resolve the model ID for a given role within a profile.
 * Falls back to the profile's `default` role if the specific role is not found.
 *
 * @param role    - The semantic role to resolve.
 * @param profile - The profile to resolve against.
 */
export function resolveModelForRole(role: ModelRole, profile: ModelProfile): string {
  return profile.roles[role];
}

/**
 * Look up a profile by name from the built-in registry.
 *
 * @param name - Profile name (e.g. "copilot-default").
 * @returns The matching profile, or undefined if not found.
 */
export function findProfile(name: string): ModelProfile | undefined {
  return MODEL_PROFILES[name];
}
