import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";

import { resolvePlanRef } from "./cerebrum-plan-source";

const FIXTURE = join(import.meta.dir, "fixtures", "fake-cerebrum-stdio.ts");

describe("resolvePlanRef", () => {
  afterEach(() => {
    process.env.FAKE_CEREBRUM_RESULTS = undefined;
  });

  it("returns an error when cerebrumBin is empty", async () => {
    const result = await resolvePlanRef("abc", { cerebrumBin: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("CEREBRUM_BIN");
  });

  it("prefers the exact plan-scoped result over global noise", async () => {
    process.env.FAKE_CEREBRUM_RESULTS = JSON.stringify([
      { id: "g1", content: "NOISE global body", scope: "global" },
      { id: "p1", content: "# Real Plan\nbody", scope: "plan:abc" },
    ]);

    const result = await resolvePlanRef("abc", { cerebrumBin: FIXTURE });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("# Real Plan\nbody");
  });

  it("returns an error when only a global result is present", async () => {
    process.env.FAKE_CEREBRUM_RESULTS = JSON.stringify([
      { id: "g1", content: "global only", scope: "global" },
    ]);

    const result = await resolvePlanRef("abc", { cerebrumBin: FIXTURE });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("no plan found");
  });

  it("returns an error when no results are present at all", async () => {
    process.env.FAKE_CEREBRUM_RESULTS = JSON.stringify([]);

    const result = await resolvePlanRef("missing-ref", { cerebrumBin: FIXTURE });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("missing-ref");
  });

  it("returns an error when the cerebrum binary cannot be spawned", async () => {
    const result = await resolvePlanRef("abc", {
      cerebrumBin: "/nonexistent/path/to/cerebrum",
    });

    expect(result.ok).toBe(false);
  });
});
