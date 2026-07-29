import { describe, expect, it } from "bun:test";

import {
  ANTHROPIC_SONNET_PROFILE,
  BEDROCK_SONNET_PROFILE,
  COPILOT_DEFAULT_PROFILE,
  DEFAULT_PROFILE_NAME,
  HYBRID_PROFILE,
  LOCAL_PROFILE,
  MODEL_PROFILES,
  OPENCODE_FREE_PROFILE,
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

describe("COPILOT_DEFAULT_PROFILE", () => {
  it("has name copilot-default", () => {
    expect(COPILOT_DEFAULT_PROFILE.name).toBe("copilot-default");
  });

  it("maps all roles to claude-sonnet-4.6", () => {
    const roles = Object.values(COPILOT_DEFAULT_PROFILE.roles);
    for (const model of roles) {
      expect(model).toBe("claude-sonnet-4.6");
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
      expect(COPILOT_DEFAULT_PROFILE.roles).toHaveProperty(role);
    }
  });
});

describe("HYBRID_PROFILE", () => {
  it("has name hybrid", () => {
    expect(HYBRID_PROFILE.name).toBe("hybrid");
  });

  it("maps implementer and tester to gemma4:26b", () => {
    expect(HYBRID_PROFILE.roles.implementer).toBe("gemma4:26b");
    expect(HYBRID_PROFILE.roles.tester).toBe("gemma4:26b");
    expect(HYBRID_PROFILE.roles.debugger).toBe("gemma4:26b");
  });

  it("maps planner, fixer, reviewer, scaffolder, explorer to claude-sonnet-4.6", () => {
    expect(HYBRID_PROFILE.roles.planner).toBe("claude-sonnet-4.6");
    expect(HYBRID_PROFILE.roles.fixer).toBe("claude-sonnet-4.6");
    expect(HYBRID_PROFILE.roles.reviewer).toBe("claude-sonnet-4.6");
    expect(HYBRID_PROFILE.roles.scaffolder).toBe("claude-sonnet-4.6");
    expect(HYBRID_PROFILE.roles.explorer).toBe("claude-sonnet-4.6");
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
      expect(HYBRID_PROFILE.roles).toHaveProperty(role);
    }
  });
});

describe("ANTHROPIC_SONNET_PROFILE", () => {
  it("has name anthropic-sonnet", () => {
    expect(ANTHROPIC_SONNET_PROFILE.name).toBe("anthropic-sonnet");
  });

  it("maps all roles to claude-sonnet-5", () => {
    const roles = Object.values(ANTHROPIC_SONNET_PROFILE.roles);
    for (const model of roles) {
      expect(model).toBe("claude-sonnet-5");
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
      expect(ANTHROPIC_SONNET_PROFILE.roles).toHaveProperty(role);
    }
  });
});

describe("BEDROCK_SONNET_PROFILE", () => {
  it("has name bedrock-sonnet", () => {
    expect(BEDROCK_SONNET_PROFILE.name).toBe("bedrock-sonnet");
  });

  it("maps all roles to the bedrock-sonnet logical token", () => {
    const roles = Object.values(BEDROCK_SONNET_PROFILE.roles);
    for (const model of roles) {
      expect(model).toBe("bedrock-sonnet");
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
      expect(BEDROCK_SONNET_PROFILE.roles).toHaveProperty(role);
    }
  });
});

describe("OPENCODE_FREE_PROFILE", () => {
  it("has name opencode-free", () => {
    expect(OPENCODE_FREE_PROFILE.name).toBe("opencode-free");
  });

  it("maps all roles to the opencode-free logical token", () => {
    const roles = Object.values(OPENCODE_FREE_PROFILE.roles);
    for (const model of roles) {
      expect(model).toBe("opencode-free");
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
      expect(OPENCODE_FREE_PROFILE.roles).toHaveProperty(role);
    }
  });

  it("resolves every role to opencode-free via resolveModelForRole", () => {
    const roles: Array<keyof typeof OPENCODE_FREE_PROFILE.roles> = [
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
    for (const role of roles) {
      expect(resolveModelForRole(role, OPENCODE_FREE_PROFILE)).toBe("opencode-free");
    }
  });
});

describe("MODEL_PROFILES", () => {
  it("contains the local profile", () => {
    expect(MODEL_PROFILES.local).toBe(LOCAL_PROFILE);
  });

  it("contains copilot-default", () => {
    expect(MODEL_PROFILES["copilot-default"]).toBe(COPILOT_DEFAULT_PROFILE);
  });

  it("contains hybrid", () => {
    expect(MODEL_PROFILES.hybrid).toBe(HYBRID_PROFILE);
  });

  it("contains anthropic-sonnet", () => {
    expect(MODEL_PROFILES["anthropic-sonnet"]).toBe(ANTHROPIC_SONNET_PROFILE);
  });

  it("contains bedrock-sonnet", () => {
    expect(MODEL_PROFILES["bedrock-sonnet"]).toBe(BEDROCK_SONNET_PROFILE);
  });

  it("contains opencode-free", () => {
    expect(MODEL_PROFILES["opencode-free"]).toBe(OPENCODE_FREE_PROFILE);
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

  it("returns OPENCODE_FREE_PROFILE for 'opencode-free'", () => {
    const profile = findProfile("opencode-free");
    expect(profile?.name).toBe("opencode-free");
  });

  it("returns undefined for an unknown profile name", () => {
    expect(findProfile("does-not-exist")).toBeUndefined();
  });
});
