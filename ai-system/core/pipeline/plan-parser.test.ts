import { describe, expect, it } from "bun:test";

import { parsePlanFile } from "./plan-parser";

const VALID_MULTI_PHASE = `# Feature: Add error handling

## Phase 1: Core error types

Commit message: feat: add core error types

### Step 1: Define ErrorKind enum

Create an ErrorKind enum with variants for IO, Parse, and Network errors.

### Step 2: Define AppError struct

Create an AppError struct wrapping ErrorKind with a message field.

## Phase 2: Propagation helpers

Commit message: feat: add error propagation helpers

### Step 1: Add from-io conversion

Implement From<std::io::Error> for AppError.
`;

const MINIMAL_PLAN = `# Feature: Minimal

## Phase 1: Only phase

Commit message: chore: minimal

### Step 1: Only step

Do the thing.
`;

describe("parsePlanFile", () => {
  it("parses feature name from # Feature: heading", () => {
    const result = parsePlanFile(VALID_MULTI_PHASE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.feature).toBe("Add error handling");
  });

  it("parses two phases from a multi-phase plan", () => {
    const result = parsePlanFile(VALID_MULTI_PHASE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.phases).toHaveLength(2);
  });

  it("parses phase titles", () => {
    const result = parsePlanFile(VALID_MULTI_PHASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases[0]?.title).toBe("Core error types");
      expect(result.value.phases[1]?.title).toBe("Propagation helpers");
    }
  });

  it("parses phase numbers", () => {
    const result = parsePlanFile(VALID_MULTI_PHASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases[0]?.number).toBe(1);
      expect(result.value.phases[1]?.number).toBe(2);
    }
  });

  it("parses commit messages for each phase", () => {
    const result = parsePlanFile(VALID_MULTI_PHASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases[0]?.commitMessage).toBe("feat: add core error types");
      expect(result.value.phases[1]?.commitMessage).toBe("feat: add error propagation helpers");
    }
  });

  it("parses steps within a phase", () => {
    const result = parsePlanFile(VALID_MULTI_PHASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases[0]?.steps).toHaveLength(2);
      expect(result.value.phases[1]?.steps).toHaveLength(1);
    }
  });

  it("parses step titles", () => {
    const result = parsePlanFile(VALID_MULTI_PHASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases[0]?.steps[0]?.title).toBe("Define ErrorKind enum");
      expect(result.value.phases[0]?.steps[1]?.title).toBe("Define AppError struct");
    }
  });

  it("parses step numbers", () => {
    const result = parsePlanFile(VALID_MULTI_PHASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases[0]?.steps[0]?.number).toBe(1);
      expect(result.value.phases[0]?.steps[1]?.number).toBe(2);
    }
  });

  it("preserves freeform step body content", () => {
    const result = parsePlanFile(VALID_MULTI_PHASE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const body = result.value.phases[0]?.steps[0]?.body ?? "";
      expect(body).toContain("ErrorKind enum");
      expect(body).toContain("IO, Parse, and Network");
    }
  });

  it("parses a minimal single-phase single-step plan", () => {
    const result = parsePlanFile(MINIMAL_PLAN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.feature).toBe("Minimal");
      expect(result.value.phases).toHaveLength(1);
      expect(result.value.phases[0]?.steps).toHaveLength(1);
      expect(result.value.phases[0]?.steps[0]?.body).toContain("Do the thing.");
    }
  });

  it("returns error when # Feature: heading is missing", () => {
    const content = "## Phase 1: Something\n\nCommit message: feat: x\n\n### Step 1: Do\n\nbody\n";
    const result = parsePlanFile(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("# Feature:");
  });

  it("returns error when there are no phases", () => {
    const result = parsePlanFile("# Feature: Empty\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("no phases");
  });

  it("returns error when a phase has no commit message", () => {
    const content = "# Feature: Test\n\n## Phase 1: Missing commit\n\n### Step 1: Do\n\nbody\n";
    const result = parsePlanFile(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Commit message");
  });

  it("returns error when a phase has no steps", () => {
    const content = "# Feature: Test\n\n## Phase 1: No steps\n\nCommit message: feat: x\n";
    const result = parsePlanFile(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("no steps");
  });

  it("step body is trimmed of leading and trailing blank lines", () => {
    const result = parsePlanFile(MINIMAL_PLAN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const body = result.value.phases[0]?.steps[0]?.body ?? "";
      expect(body).toBe("Do the thing.");
    }
  });

  it("multi-line step body is preserved intact", () => {
    const content = `# Feature: Multi-line

## Phase 1: Phase

Commit message: feat: multi

### Step 1: Step

Line one.
Line two.
Line three.
`;
    const result = parsePlanFile(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const body = result.value.phases[0]?.steps[0]?.body ?? "";
      expect(body).toContain("Line one.");
      expect(body).toContain("Line two.");
      expect(body).toContain("Line three.");
    }
  });

  it("Language: lines are no longer a recognised directive (removed with --language)", () => {
    // The Language: directive was removed along with --language -- routing
    // is now derived entirely from the workspace's devShell palette (see
    // route()). A stray "Language:" line before any step heading is simply
    // ignored (not an error), matching the same tolerance any other
    // unrecognised line outside a step body already has.
    const content = `# Feature: Lang

## Phase 1: Phase

Commit message: feat: rust
Language: rust

### Step 1: Do

body
`;
    const result = parsePlanFile(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases[0]).not.toHaveProperty("language");
    }
  });

  it("returns an error for an invalid coverage percent", () => {
    const content = `# Feature: Bad coverage

## Phase 1: Phase

Commit message: feat: thing
Coverage: 150%

### Step 1: Do

body
`;
    const result = parsePlanFile(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("invalid coverage percent");
      expect(result.error.message).toContain("150%");
    }
  });

  it("returns an error for an invalid coverage directive", () => {
    const content = `# Feature: Bad coverage

## Phase 1: Phase

Commit message: feat: thing
Coverage: maybe

### Step 1: Do

body
`;
    const result = parsePlanFile(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("invalid coverage directive");
      expect(result.error.message).toContain("maybe");
    }
  });
});
