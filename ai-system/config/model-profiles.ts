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

/** Registry of all built-in profiles, keyed by profile name. */
export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = {
  [LOCAL_PROFILE.name]: LOCAL_PROFILE,
};

/** The profile name used when no explicit profile is requested. */
export const DEFAULT_PROFILE_NAME = "local";

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
