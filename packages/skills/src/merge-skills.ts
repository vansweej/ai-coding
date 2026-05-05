import type { ResolvedSkill } from "./skill-types";

/**
 * Merge resolved skills into a single string for injection into an LLM system prompt.
 *
 * Each skill is wrapped with a Markdown header using its name, so the LLM can
 * distinguish where one skill ends and the next begins. Skills are separated by
 * a horizontal rule.
 *
 * Ordering is preserved from the input array: action skills appear before workspace
 * skills, matching the resolution order from `resolveSkillNames`.
 *
 * Returns an empty string when the input array is empty — callers can safely
 * skip system prompt injection when the result is empty.
 *
 * @param skills - Ordered array of resolved skills to merge.
 * @returns A single string ready for use as (or appended to) an LLM system prompt.
 *
 * @example
 * const skills = await resolveSkill(context, backend);
 * const systemPrompt = mergeSkills(skills);
 * // "## Skill: programmer\n\n...\n\n---\n\n## Skill: rust\n\n..."
 */
export function mergeSkills(skills: readonly ResolvedSkill[]): string {
  if (skills.length === 0) {
    return "";
  }

  return skills.map((s) => `## Skill: ${s.name}\n\n${s.content}`).join("\n\n---\n\n");
}
