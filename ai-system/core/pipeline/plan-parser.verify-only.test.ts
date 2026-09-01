import { describe, expect, it } from "bun:test";

import { parsePlanFile } from "./plan-parser";

describe("verify-only Mode directive", () => {
  it("parses a verify-only zero-step phase with at least one Assert line", () => {
    const content = `# Feature: Verify only

## Phase 1: Check state

Commit message: chore: verify only
Mode: verify-only
Assert: exists docs/x.md
`;
    const result = parsePlanFile(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases[0]?.verifyOnly).toBe(true);
      expect(result.value.phases[0]?.steps).toHaveLength(0);
    }
  });

  it("parses a normal phase with verifyOnly === false", () => {
    const content = `# Feature: Normal

## Phase 1: Do stuff

Commit message: feat: do stuff

### Step 1: Do it

body
`;
    const result = parsePlanFile(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases[0]?.verifyOnly).toBe(false);
    }
  });

  it("fails a verify-only phase with zero asserts", () => {
    const content = `# Feature: Bad verify only

## Phase 1: Check state

Commit message: chore: verify only
Mode: verify-only
`;
    const result = parsePlanFile(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("verify-only but declares no");
    }
  });

  it("fails on an invalid Mode directive", () => {
    const content = `# Feature: Bad mode

## Phase 1: Check state

Commit message: chore: bad mode
Mode: bogus
Assert: exists docs/x.md
`;
    const result = parsePlanFile(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("invalid Mode directive");
    }
  });

  it("fails a zero-step phase without the verify-only directive", () => {
    const content = `# Feature: No steps

## Phase 1: Empty phase

Commit message: chore: empty
`;
    const result = parsePlanFile(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("has no steps and is not verify-only");
    }
  });

  it("ignores a stray Mode: verify-only line appearing before any Phase heading", () => {
    const content = `# Feature: Stray mode

Mode: verify-only

## Phase 1: Do stuff

Commit message: feat: do stuff

### Step 1: Do it

body
`;
    const result = parsePlanFile(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.phases[0]?.verifyOnly).toBe(false);
    }
  });
});
