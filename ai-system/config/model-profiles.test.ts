import { describe, expect, it } from "bun:test";

import {
  COPILOT_DEFAULT_PROFILE,
  DEFAULT_PROFILE_NAME,
  MODEL_PROFILES,
  findProfile,
  resolveModelForRole,
} from "./model-profiles";

describe("COPILOT_DEFAULT_PROFILE", () => {
  it("has name copilot-default", () => {
    expect(COPILOT_DEFAULT_PROFILE.name).toBe("copilot-default");
  });

  it("maps planner to claude-sonnet-4.6", () => {
    expect(COPILOT_DEFAULT_PROFILE.roles.planner).toBe("claude-sonnet-4.6");
  });

  it("maps implementer to claude-sonnet-4.6", () => {
    expect(COPILOT_DEFAULT_PROFILE.roles.implementer).toBe("claude-sonnet-4.6");
  });

  it("maps debugger to claude-sonnet-4.6", () => {
    expect(COPILOT_DEFAULT_PROFILE.roles.debugger).toBe("claude-sonnet-4.6");
  });

  it("maps reviewer to claude-sonnet-4.6", () => {
    expect(COPILOT_DEFAULT_PROFILE.roles.reviewer).toBe("claude-sonnet-4.6");
  });

  it("maps tester to claude-sonnet-4.6", () => {
    expect(COPILOT_DEFAULT_PROFILE.roles.tester).toBe("claude-sonnet-4.6");
  });

  it("maps scaffolder to claude-sonnet-4.6", () => {
    expect(COPILOT_DEFAULT_PROFILE.roles.scaffolder).toBe("claude-sonnet-4.6");
  });

  it("maps default to claude-sonnet-4.6", () => {
    expect(COPILOT_DEFAULT_PROFILE.roles.default).toBe("claude-sonnet-4.6");
  });
});

describe("MODEL_PROFILES", () => {
  it("contains the copilot-default profile", () => {
    expect(MODEL_PROFILES["copilot-default"]).toBeDefined();
  });

  it("copilot-default entry is the same object as COPILOT_DEFAULT_PROFILE", () => {
    expect(MODEL_PROFILES["copilot-default"]).toBe(COPILOT_DEFAULT_PROFILE);
  });
});

describe("DEFAULT_PROFILE_NAME", () => {
  it("is copilot-default", () => {
    expect(DEFAULT_PROFILE_NAME).toBe("copilot-default");
  });

  it("resolves to an entry in MODEL_PROFILES", () => {
    expect(MODEL_PROFILES[DEFAULT_PROFILE_NAME]).toBeDefined();
  });
});

describe("resolveModelForRole", () => {
  it("returns claude-sonnet-4.6 for planner in copilot-default", () => {
    expect(resolveModelForRole("planner", COPILOT_DEFAULT_PROFILE)).toBe("claude-sonnet-4.6");
  });

  it("returns claude-sonnet-4.6 for implementer in copilot-default", () => {
    expect(resolveModelForRole("implementer", COPILOT_DEFAULT_PROFILE)).toBe("claude-sonnet-4.6");
  });

  it("returns claude-sonnet-4.6 for default role in copilot-default", () => {
    expect(resolveModelForRole("default", COPILOT_DEFAULT_PROFILE)).toBe("claude-sonnet-4.6");
  });
});

describe("findProfile", () => {
  it("returns COPILOT_DEFAULT_PROFILE for 'copilot-default'", () => {
    expect(findProfile("copilot-default")).toBe(COPILOT_DEFAULT_PROFILE);
  });

  it("returns undefined for an unknown profile name", () => {
    expect(findProfile("does-not-exist")).toBeUndefined();
  });
});
