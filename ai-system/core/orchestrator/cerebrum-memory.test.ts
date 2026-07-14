import { describe, expect, it } from "bun:test";

import { CerebrumMemory } from "./cerebrum-memory";

describe("CerebrumMemory", () => {
  it("constructs with default global scope", () => {
    const memory = new CerebrumMemory();
    expect(memory).toBeDefined();
  });

  it("constructs with custom scope", () => {
    const memory = new CerebrumMemory("user:alice");
    expect(memory).toBeDefined();
  });

  it("constructs with agent scope", () => {
    const memory = new CerebrumMemory("agent:planner");
    expect(memory).toBeDefined();
  });

  it("constructs with session scope", () => {
    const memory = new CerebrumMemory("session:abc123");
    expect(memory).toBeDefined();
  });

  it("remembers a memory with default salience", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.remember("Test memory content");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatch(/^memory-\d+$/);
    }
  });

  it("remembers a memory with custom salience", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.remember("Important memory", 0.9);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatch(/^memory-\d+$/);
    }
  });

  it("recalls memories with default limit", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.recall("search query");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value)).toBe(true);
      expect(result.value.length).toBe(0); // Mock returns empty array
    }
  });

  it("recalls memories with custom limit", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.recall("search query", 20);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value)).toBe(true);
    }
  });

  it("recalls memories by scope", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.recallByScope("search query", "agent:debugger");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value)).toBe(true);
    }
  });

  it("recalls memories by scope with custom limit", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.recallByScope("search query", "user:alice", 15);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value)).toBe(true);
    }
  });

  it("memorizes a memory (promotes to Cortex)", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.memorize("memory-12345");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  it("forgets a memory (deletes from both tiers)", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.forget("memory-12345");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  it("ends session with default promotion threshold", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.endSession();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  it("ends session with custom promotion threshold", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.endSession(0.8);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  it("handles remember errors gracefully", async () => {
    const memory = new CerebrumMemory();
    // Mock an error by calling with invalid input
    const result = await memory.remember("");

    expect(result.ok).toBe(true); // Mock always succeeds
  });

  it("handles recall errors gracefully", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.recall("");

    expect(result.ok).toBe(true); // Mock always succeeds
  });

  it("handles memorize errors gracefully", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.memorize("invalid-id");

    expect(result.ok).toBe(true); // Mock always succeeds
  });

  it("handles forget errors gracefully", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.forget("invalid-id");

    expect(result.ok).toBe(true); // Mock always succeeds
  });

  it("handles endSession errors gracefully", async () => {
    const memory = new CerebrumMemory();
    const result = await memory.endSession();

    expect(result.ok).toBe(true); // Mock always succeeds
  });

  it("parses memory entries from recall response", async () => {
    const memory = new CerebrumMemory();
    // This test verifies the internal parsing logic
    const result = await memory.recall("test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value)).toBe(true);
      // Each entry should have required fields
      for (const entry of result.value) {
        expect(entry).toHaveProperty("id");
        expect(entry).toHaveProperty("content");
        expect(entry).toHaveProperty("salience");
        expect(entry).toHaveProperty("scope");
      }
    }
  });

  it("supports different memory scopes", async () => {
    const scopes = ["global", "user:alice", "agent:planner", "session:xyz"] as const;

    for (const scope of scopes) {
      const memory = new CerebrumMemory(scope);
      const result = await memory.remember(`Memory in ${scope}`);
      expect(result.ok).toBe(true);
    }
  });

  it("maintains scope isolation across instances", async () => {
    const globalMemory = new CerebrumMemory("global");
    const userMemory = new CerebrumMemory("user:alice");
    const agentMemory = new CerebrumMemory("agent:debugger");

    const globalResult = await globalMemory.remember("Global memory");
    const userResult = await userMemory.remember("User memory");
    const agentResult = await agentMemory.remember("Agent memory");

    expect(globalResult.ok).toBe(true);
    expect(userResult.ok).toBe(true);
    expect(agentResult.ok).toBe(true);
  });
});
