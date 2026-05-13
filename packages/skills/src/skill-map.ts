import type { AIAction } from "@ai-coding/shared";

import type { WorkspaceType } from "./skill-types";

/**
 * Maps each AI action to the "what to do" skills — general method instructions.
 * These skills describe how to perform a task regardless of the technology stack.
 *
 * Ordering within each array is significant: skills appear in the merged output
 * in the order listed here, before any workspace skills are appended.
 *
 * When new AIAction values are added (e.g. "test", "review", "document"),
 * add the corresponding entries here alongside updates to actionToRole() in
 * ai-system/core/model-router/action-to-role.ts.
 */
export const ACTION_SKILLS: Readonly<Record<AIAction, readonly string[]>> = {
  edit: ["programmer"],
  refactor: ["programmer"],
  debug: ["debugger"],
  fix: ["debugger"],
  plan: ["architect"],
  explore: ["explorer"],
  explain: ["analyst"],
  chat: [],
  task: ["programmer"],
};

/**
 * Maps each detected workspace type to "how to do it here" skills — domain
 * specialization instructions appended after action skills.
 *
 * Workspace skills act as a narrowing constraint: they refine the general method
 * with language-specific idioms, tooling, and conventions.
 */
export const WORKSPACE_SKILLS: Readonly<Record<WorkspaceType, readonly string[]>> = {
  rust: ["rust"],
  cpp: ["cpp"],
  typescript: ["typescript"],
  unknown: [],
};

/**
 * Resolve the ordered list of skill names for a given action and workspace type.
 *
 * Resolution strategy:
 *   1. Start with action skills (general method — "what to do")
 *   2. Append workspace skills (domain specialization — "how to do it here")
 *
 * The ordering is intentional: domain skills act as a specialization layer on
 * top of the general method, so the LLM reads general instructions first and
 * domain constraints last.
 *
 * @param action        - The AI action being performed.
 * @param workspaceType - The detected workspace project type.
 * @returns Ordered list of skill names to resolve, with no duplicates guaranteed
 *          by the static maps (action and workspace skills are disjoint sets).
 */
export function resolveSkillNames(
  action: AIAction,
  workspaceType: WorkspaceType,
): readonly string[] {
  return [...ACTION_SKILLS[action], ...WORKSPACE_SKILLS[workspaceType]];
}
