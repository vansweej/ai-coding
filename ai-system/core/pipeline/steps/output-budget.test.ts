import { describe, expect, it } from "bun:test";

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_OUTPUT_TOKENS_ENV,
  resolveMaxOutputTokens,
} from "./output-budget";

describe("resolveMaxOutputTokens", () => {
  it("returns the default when the environment does not set a value", () => {
    const env: Record<string, string | undefined> = {};

    expect(resolveMaxOutputTokens(env)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("returns a valid positive integer override", () => {
    const env: Record<string, string | undefined> = { [MAX_OUTPUT_TOKENS_ENV]: "32000" };

    expect(resolveMaxOutputTokens(env)).toBe(32_000);
  });

  it("falls back for a non-numeric override", () => {
    const env: Record<string, string | undefined> = { [MAX_OUTPUT_TOKENS_ENV]: "many" };

    expect(resolveMaxOutputTokens(env)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("falls back for zero and negative overrides", () => {
    const zeroEnv: Record<string, string | undefined> = { [MAX_OUTPUT_TOKENS_ENV]: "0" };
    const negativeEnv: Record<string, string | undefined> = { [MAX_OUTPUT_TOKENS_ENV]: "-1" };

    expect(resolveMaxOutputTokens(zeroEnv)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(negativeEnv)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });

  it("falls back for a fractional override", () => {
    const env: Record<string, string | undefined> = { [MAX_OUTPUT_TOKENS_ENV]: "1.5" };

    expect(resolveMaxOutputTokens(env)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});
