import { describe, expect, it } from "bun:test";

describe("reflexivity self-test", () => {
  it("passes a simple assertion", () => {
    expect(1).toBe(1);
  });
});
