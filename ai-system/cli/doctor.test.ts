import { describe, expect, it } from "bun:test";
import { runDoctorSandboxed } from "./doctor";

describe("runDoctorSandboxed", () => {
  it("returns ok === true with an empty failures list on the real import graph", async () => {
    const result = await runDoctorSandboxed();
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});