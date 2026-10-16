import { describe, expect, it } from "bun:test";

import { isNonRetryableLogicError } from "./verified-implement-step";

describe("isNonRetryableLogicError", () => {
  /** Output truncation must remain eligible for the larger-budget retry. */
  it("keeps OutputTruncatedError retryable", () => {
    const error = new Error("Copilot truncated the completion");
    error.name = "OutputTruncatedError";

    expect(isNonRetryableLogicError(error)).toBe(false);
  });
});
