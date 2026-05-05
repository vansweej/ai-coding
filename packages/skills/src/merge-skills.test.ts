import { describe, expect, it } from "bun:test";

import { mergeSkills } from "./merge-skills";
import type { ResolvedSkill } from "./skill-types";

const PROGRAMMER_SKILL: ResolvedSkill = {
  name: "programmer",
  content: "You are a senior software engineer.",
};

const RUST_SKILL: ResolvedSkill = {
  name: "rust",
  content: "Use idiomatic Rust. Prefer Result over unwrap.",
};

const DEBUGGER_SKILL: ResolvedSkill = {
  name: "debugger",
  content: "Diagnose root causes systematically.",
};

describe("mergeSkills", () => {
  it("returns empty string for empty array", () => {
    expect(mergeSkills([])).toBe("");
  });

  it("wraps a single skill with its name as a header", () => {
    const result = mergeSkills([PROGRAMMER_SKILL]);
    expect(result).toBe("## Skill: programmer\n\nYou are a senior software engineer.");
  });

  it("separates two skills with a horizontal rule", () => {
    const result = mergeSkills([PROGRAMMER_SKILL, RUST_SKILL]);
    expect(result).toContain("---");
    expect(result.indexOf("programmer")).toBeLessThan(result.indexOf("rust"));
  });

  it("preserves ordering — action skill before workspace skill", () => {
    const result = mergeSkills([PROGRAMMER_SKILL, RUST_SKILL]);
    expect(result.indexOf("## Skill: programmer")).toBeLessThan(result.indexOf("## Skill: rust"));
  });

  it("includes skill content for each skill", () => {
    const result = mergeSkills([PROGRAMMER_SKILL, RUST_SKILL]);
    expect(result).toContain("You are a senior software engineer.");
    expect(result).toContain("Use idiomatic Rust.");
  });

  it("handles three skills with correct separators", () => {
    const result = mergeSkills([PROGRAMMER_SKILL, DEBUGGER_SKILL, RUST_SKILL]);
    const separatorCount = (result.match(/---/g) ?? []).length;
    expect(separatorCount).toBe(2);
  });

  it("each skill header uses the skill name", () => {
    const result = mergeSkills([PROGRAMMER_SKILL, RUST_SKILL]);
    expect(result).toContain("## Skill: programmer");
    expect(result).toContain("## Skill: rust");
  });

  it("works with a skill that has a relevance score (vector backend)", () => {
    const scoredSkill: ResolvedSkill = { name: "programmer", content: "content", relevance: 0.95 };
    const result = mergeSkills([scoredSkill]);
    expect(result).toContain("## Skill: programmer");
    expect(result).toContain("content");
  });
});
