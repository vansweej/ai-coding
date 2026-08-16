import { describe, expect, it } from "bun:test";

import { parsePlanFile } from "./plan-parser";

describe("degradations", () => {
  it("degradations contains `Phase N: ...`", () => {
    const plan = `# Feature: Test degradation

## Phase 1: First phase

Commit message: feat: first phase

### Step 1: Do something

Do something here.

## Phase 2: Second phase

Commit message: feat: second phase

### Step 1: Do more

Do more here.
`;

    const result = parsePlanFile(plan);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const degradations = result.value.phases.map(
      (phase) => `Phase ${phase.number}: ${phase.title}`,
    );

    expect(degradations).toContain("Phase 1: First phase");
    expect(degradations).toContain("Phase 2: Second phase");
    for (const d of degradations) {
      expect(d).toMatch(/^Phase \d+: .+/);
    }
  });
});
