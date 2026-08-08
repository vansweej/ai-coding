import { describe, expect, it } from "bun:test";
import { STRUCTURED_PATCH_SYSTEM } from "./patch-guidance";

describe("STRUCTURED_PATCH_SYSTEM", () => {
  it("is a non-empty string", () => {
    expect(typeof STRUCTURED_PATCH_SYSTEM).toBe("string");
    expect(STRUCTURED_PATCH_SYSTEM.length).toBeGreaterThan(0);
  });

  it("mentions both edit and create guidance", () => {
    const lower = STRUCTURED_PATCH_SYSTEM.toLowerCase();
    expect(lower).toContain("edit");
    expect(lower).toContain("create");
  });
});
