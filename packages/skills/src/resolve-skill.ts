import type { ResolvedSkill, RetrievalContext, SkillBackend } from "./skill-types";

/**
 * Resolve relevant skills for the given context using the provided backend.
 *
 * This is the stable public API for skill retrieval. Consumers are blind to
 * whether the backend reads files (Phase 1) or queries a vector database (Phase 2).
 * Swapping backends requires no changes to consumers.
 *
 * The returned array is ordered: action skills first, workspace skills last.
 * Pass the result to `mergeSkills()` to produce a single string for system
 * prompt injection, or inspect individual `ResolvedSkill` entries for more
 * control (e.g. token budgeting, relevance filtering in Phase 2).
 *
 * @param context - Narrow retrieval context (action + optional workspace path).
 * @param backend - The skill backend to delegate resolution to.
 * @returns Ordered array of resolved skills. Empty when no skills match.
 *
 * @example
 * const backend = new FileBackend();
 * const skills = await resolveSkill({ action: "edit", workspace: "/my/project" }, backend);
 * const systemPrompt = mergeSkills(skills);
 */
export async function resolveSkill(
  context: RetrievalContext,
  backend: SkillBackend,
): Promise<readonly ResolvedSkill[]> {
  return backend.resolve(context);
}
