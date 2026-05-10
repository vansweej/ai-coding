import { describe, expect, it } from "bun:test";

import { ACTION_SKILLS, WORKSPACE_SKILLS, resolveSkillNames } from "./skill-map";

describe("ACTION_SKILLS", () => {
  it("maps edit to programmer", () => {
    expect(ACTION_SKILLS.edit).toEqual(["programmer"]);
  });

  it("maps refactor to programmer", () => {
    expect(ACTION_SKILLS.refactor).toEqual(["programmer"]);
  });

  it("maps debug to debugger", () => {
    expect(ACTION_SKILLS.debug).toEqual(["debugger"]);
  });

  it("maps plan to architect", () => {
    expect(ACTION_SKILLS.plan).toEqual(["architect"]);
  });

  it("maps explore to explorer", () => {
    expect(ACTION_SKILLS.explore).toEqual(["explorer"]);
  });

  it("maps explain to analyst", () => {
    expect(ACTION_SKILLS.explain).toEqual(["analyst"]);
  });

  it("maps chat to empty array", () => {
    expect(ACTION_SKILLS.chat).toEqual([]);
  });

  it("maps task to programmer", () => {
    expect(ACTION_SKILLS.task).toEqual(["programmer"]);
  });
});

describe("WORKSPACE_SKILLS", () => {
  it("maps rust to rust skill", () => {
    expect(WORKSPACE_SKILLS.rust).toEqual(["rust"]);
  });

  it("maps cpp to cpp skill", () => {
    expect(WORKSPACE_SKILLS.cpp).toEqual(["cpp"]);
  });

  it("maps typescript to typescript skill", () => {
    expect(WORKSPACE_SKILLS.typescript).toEqual(["typescript"]);
  });

  it("maps unknown to empty array", () => {
    expect(WORKSPACE_SKILLS.unknown).toEqual([]);
  });
});

describe("resolveSkillNames", () => {
  it("returns action skill + workspace skill for edit in rust", () => {
    expect(resolveSkillNames("edit", "rust")).toEqual(["programmer", "rust"]);
  });

  it("returns action skill + workspace skill for debug in cpp", () => {
    expect(resolveSkillNames("debug", "cpp")).toEqual(["debugger", "cpp"]);
  });

  it("returns only action skill when workspace is unknown", () => {
    expect(resolveSkillNames("plan", "unknown")).toEqual(["architect"]);
  });

  it("returns action skill + workspace skill for edit in typescript", () => {
    expect(resolveSkillNames("edit", "typescript")).toEqual(["programmer", "typescript"]);
  });

  it("returns only workspace skill when action has no skills (chat + typescript)", () => {
    expect(resolveSkillNames("chat", "typescript")).toEqual(["typescript"]);
  });

  it("returns action skill + workspace skill for refactor in typescript", () => {
    expect(resolveSkillNames("refactor", "typescript")).toEqual(["programmer", "typescript"]);
  });

  it("returns only workspace skill when action has no skills (chat + rust)", () => {
    expect(resolveSkillNames("chat", "rust")).toEqual(["rust"]);
  });

  it("returns empty array when both action and workspace have no skills (chat + unknown)", () => {
    expect(resolveSkillNames("chat", "unknown")).toEqual([]);
  });

  it("places action skills before workspace skills", () => {
    const names = resolveSkillNames("edit", "rust");
    expect(names.indexOf("programmer")).toBeLessThan(names.indexOf("rust"));
  });

  it("returns action skill for explore in cpp", () => {
    expect(resolveSkillNames("explore", "cpp")).toEqual(["explorer", "cpp"]);
  });

  it("returns action skill for explain in unknown", () => {
    expect(resolveSkillNames("explain", "unknown")).toEqual(["analyst"]);
  });

  it("returns action skill for task in rust", () => {
    expect(resolveSkillNames("task", "rust")).toEqual(["programmer", "rust"]);
  });
});
