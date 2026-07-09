import { describe, expect, it } from "bun:test";

import {
  DEFAULT_PROFILE_NAME,
  LOCAL_PROFILE,
  MODEL_PROFILES,
  findProfile,
  resolveModelForRole,
} from "./model-profiles";

describe("LOCAL_PROFILE", () => {
  it("has name local", () => {
    expect(LOCAL_PROFILE.name).toBe("local");
  });

  it("maps all roles to gemma4:26b", () => {
    const roles = Object.values(LOCAL_PROFILE.roles);
    for (const model of roles) {
      expect(model).toBe("gemma4:26b");
    }
  });

  it("has all nine roles defined", () => {
    const expectedRoles = [
      "planner",
      "implementer",
      "debugger",
      "fixer",
      "reviewer",
      "tester",
      "scaffolder",
      "explorer",
      "default",
    ];
    for (const role of expectedRoles) {
      expect(LOCAL_PROFILE.roles).toHaveProperty(role);
    }
  });
});

describe("MODEL_PROFILES", () => {
  it("contains the local profile", () => {
    expect(MODEL_PROFILES.local).toBe(LOCAL_PROFILE);
  });

  it("does not contain copilot-default", () => {
    expect(MODEL_PROFILES["copilot-default"]).toBeUndefined();
  });

  it("does not contain hybrid", () => {
    expect(MODEL_PROFILES.hybrid).toBeUndefined();
  });
});

describe("DEFAULT_PROFILE_NAME", () => {
  it("is local", () => {
    expect(DEFAULT_PROFILE_NAME).toBe("local");
  });

  it("resolves to an entry in MODEL_PROFILES", () => {
    expect(MODEL_PROFILES[DEFAULT_PROFILE_NAME]).toBeDefined();
  });
});

describe("resolveModelForRole", () => {
  it("returns gemma4:26b for implementer in local", () => {
    expect(resolveModelForRole("implementer", LOCAL_PROFILE)).toBe("gemma4:26b");
  });

  it("returns gemma4:26b for fixer in local", () => {
    expect(resolveModelForRole("fixer", LOCAL_PROFILE)).toBe("gemma4:26b");
  });

  it("returns gemma4:26b for default role in local", () => {
    expect(resolveModelForRole("default", LOCAL_PROFILE)).toBe("gemma4:26b");
  });

  it("returns gemma4:26b for planner in local", () => {
    expect(resolveModelForRole("planner", LOCAL_PROFILE)).toBe("gemma4:26b");
  });
});

describe("findProfile", () => {
  it("returns LOCAL_PROFILE for 'local'", () => {
    expect(findProfile("local")).toBe(LOCAL_PROFILE);
  });

  it("returns undefined for an unknown profile name", () => {
    expect(findProfile("does-not-exist")).toBeUndefined();
  });
});
