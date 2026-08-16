import { describe, expect, it } from "bun:test";
import { mintRunId } from "../../src/run/run-id";

describe("mintRunId", () => {
  it("returns a non-empty string", () => {
    expect(mintRunId().length).toBeGreaterThan(0);
  });

  it("returns distinct values across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => mintRunId()));
    expect(ids.size).toBe(20);
  });

  it("matches the expected run-<ts>-<suffix> shape", () => {
    const id = mintRunId();
    expect(id).toMatch(/^run-[0-9a-z]+-[0-9a-z]+$/);
  });
});
