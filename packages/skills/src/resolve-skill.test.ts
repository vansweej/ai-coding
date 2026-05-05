import { describe, expect, it } from "bun:test";

import { resolveSkill } from "./resolve-skill";
import type { ResolvedSkill, RetrievalContext, SkillBackend } from "./skill-types";

function makeBackend(returns: readonly ResolvedSkill[]): SkillBackend {
  return {
    resolve: async (_ctx: RetrievalContext): Promise<readonly ResolvedSkill[]> => returns,
  };
}

describe("resolveSkill", () => {
  it("delegates to the backend and returns its result", async () => {
    const expected: ResolvedSkill[] = [{ name: "programmer", content: "content" }];
    const backend = makeBackend(expected);
    const result = await resolveSkill({ action: "edit" }, backend);
    expect(result).toEqual(expected);
  });

  it("passes the context to the backend unchanged", async () => {
    let capturedContext: RetrievalContext | undefined;
    const backend: SkillBackend = {
      resolve: async (ctx) => {
        capturedContext = ctx;
        return [];
      },
    };
    const context: RetrievalContext = { action: "debug", workspace: "/my/project" };
    await resolveSkill(context, backend);
    expect(capturedContext).toEqual(context);
  });

  it("returns empty array when backend returns no skills", async () => {
    const backend = makeBackend([]);
    const result = await resolveSkill({ action: "chat" }, backend);
    expect(result).toHaveLength(0);
  });

  it("returns multiple skills in the order the backend provides", async () => {
    const skills: ResolvedSkill[] = [
      { name: "programmer", content: "a" },
      { name: "rust", content: "b" },
    ];
    const backend = makeBackend(skills);
    const result = await resolveSkill({ action: "edit", workspace: "/rust/project" }, backend);
    expect(result[0]?.name).toBe("programmer");
    expect(result[1]?.name).toBe("rust");
  });

  it("works with a backend that returns skills with relevance scores", async () => {
    const skills: ResolvedSkill[] = [{ name: "programmer", content: "c", relevance: 0.9 }];
    const backend = makeBackend(skills);
    const result = await resolveSkill({ action: "edit" }, backend);
    expect(result[0]?.relevance).toBe(0.9);
  });
});
