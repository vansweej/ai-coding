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

/** All roles route to GitHub Copilot Claude Sonnet 5 (namespaced id copilot/claude-sonnet-5). */
export const COPILOT_DEFAULT_PROFILE: ModelProfile = {
  name: "copilot-default",
  roles: {
    planner: "copilot/claude-sonnet-5",
    implementer: "copilot/claude-sonnet-5",
    debugger: "copilot/claude-sonnet-5",
    fixer: "copilot/claude-sonnet-5",
    reviewer: "copilot/claude-sonnet-5",
    tester: "copilot/claude-sonnet-5",
    scaffolder: "copilot/claude-sonnet-5",
    explorer: "copilot/claude-sonnet-5",
    default: "copilot/claude-sonnet-5",
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
 * -> Anthropic native, "copilot/claude-sonnet-5" -> Copilot-served Sonnet 5
 * (distinct from the Anthropic-native bare id), "claude-sonnet-4.6" -> Copilot,
 * "gemma4:26b" -> Ollama).
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

/**
 * All roles route to a Claude Sonnet model hosted on Amazon Bedrock via the
 * InvokeModel API.
 *
 * The model key here is a stable logical token, not a real model ID or ARN.
 * The actual Bedrock (application) inference profile ARN to invoke is
 * resolved from the AWS_BEDROCK_INFERENCE_PROFILE_ARN environment variable in
 * load-config.ts -- never hardcoded here. This keeps the profile portable
 * across AWS accounts/employers: swapping the target model is a one-line env
 * change, not a source edit.
 */
export const BEDROCK_SONNET_PROFILE: ModelProfile = {
  name: "bedrock-sonnet",
  roles: {
    planner: "bedrock-sonnet",
    implementer: "bedrock-sonnet",
    debugger: "bedrock-sonnet",
    fixer: "bedrock-sonnet",
    reviewer: "bedrock-sonnet",
    tester: "bedrock-sonnet",
    scaffolder: "bedrock-sonnet",
    explorer: "bedrock-sonnet",
    default: "bedrock-sonnet",
  },
};

/**
 * All roles route to a free OpenCode Zen model via the OpenAI-compatible
 * chat/completions endpoint.
 *
 * The model key here is a stable logical token, not a real model ID. The
 * concrete model ID to invoke is resolved from the OPENCODE_ZEN_MODEL
 * environment variable in load-config.ts -- never hardcoded here. This
 * keeps the profile portable as the free model rotates out over time:
 * swapping the target model is a one-line env change, not a source edit.
 * Auth is an OPTIONAL Bearer API key from OPENCODE_ZEN_API_KEY -- OpenCode
 * Zen's free-tier models (e.g. deepseek-v4-flash-free) accept unauthenticated
 * requests, so no key is required unless you point this profile at a paid
 * Zen model.
 */
export const OPENCODE_FREE_PROFILE: ModelProfile = {
  name: "opencode-free",
  roles: {
    planner: "opencode-free",
    implementer: "opencode-free",
    debugger: "opencode-free",
    fixer: "opencode-free",
    reviewer: "opencode-free",
    tester: "opencode-free",
    scaffolder: "opencode-free",
    explorer: "opencode-free",
    default: "opencode-free",
  },
};

/** Registry of all built-in profiles, keyed by profile name. */
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = {
  [LOCAL_PROFILE.name]: LOCAL_PROFILE,
  [COPILOT_DEFAULT_PROFILE.name]: COPILOT_DEFAULT_PROFILE,
  [HYBRID_PROFILE.name]: HYBRID_PROFILE,
  [ANTHROPIC_SONNET_PROFILE.name]: ANTHROPIC_SONNET_PROFILE,
  [BEDROCK_SONNET_PROFILE.name]: BEDROCK_SONNET_PROFILE,
  [OPENCODE_FREE_PROFILE.name]: OPENCODE_FREE_PROFILE,
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
