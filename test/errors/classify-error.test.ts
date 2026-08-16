import { describe, expect, it } from "bun:test";

import { classifyError } from "../../src/errors/classify-error";

describe("classifyError", () => {
  describe("transient cases", () => {
    it("classifies a network error message as transient", () => {
      const result = classifyError(new Error("Network error"));
      expect(result.kind).toBe("transient");
    });

    it("classifies a connection-refused error as transient", () => {
      const result = classifyError(new Error("connect ECONNREFUSED 127.0.0.1:11434"));
      expect(result.kind).toBe("transient");
    });

    it("classifies a timeout message as transient", () => {
      const result = classifyError(new Error("Request timed out after 30000ms"));
      expect(result.kind).toBe("transient");
    });

    it("classifies a rate-limit message as transient", () => {
      const result = classifyError(new Error("Rate limit exceeded, please retry"));
      expect(result.kind).toBe("transient");
    });

    it("classifies an embedded HTTP 500 status as transient (dispatcher shape)", () => {
      const result = classifyError(new Error("Anthropic returned 500: Internal Server Error"));
      expect(result.kind).toBe("transient");
    });

    it("classifies an embedded HTTP 503 status as transient", () => {
      const result = classifyError(new Error("Copilot returned 503: Service Unavailable"));
      expect(result.kind).toBe("transient");
    });

    it("classifies an embedded HTTP 429 status as transient", () => {
      const result = classifyError(new Error("OpenCode Zen returned 429: Too Many Requests"));
      expect(result.kind).toBe("transient");
    });

    it("classifies a ThrottlingException by name as transient (Bedrock shape)", () => {
      const err = Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
      const result = classifyError(err);
      expect(result.kind).toBe("transient");
    });

    it("classifies a ServiceUnavailableException by name as transient", () => {
      const err = Object.assign(new Error("unavailable"), {
        name: "ServiceUnavailableException",
      });
      const result = classifyError(err);
      expect(result.kind).toBe("transient");
    });

    it("classifies ETIMEDOUT as transient", () => {
      const result = classifyError(new Error("connect ETIMEDOUT"));
      expect(result.kind).toBe("transient");
    });
  });

  describe("logic cases", () => {
    it("classifies a validation error message as logic", () => {
      const result = classifyError(new Error("Validation failed: missing required field"));
      expect(result.kind).toBe("logic");
    });

    it("classifies a schema-mismatch message as logic", () => {
      const result = classifyError(new Error("arguments JSON does not match our schema"));
      expect(result.kind).toBe("logic");
    });

    it("classifies an embedded HTTP 401 status as logic (auth failure, not retryable)", () => {
      const result = classifyError(new Error("Copilot returned 401: Unauthorized"));
      expect(result.kind).toBe("logic");
    });

    it("classifies an embedded HTTP 400 status as logic", () => {
      const result = classifyError(new Error("Anthropic returned 400: Bad Request"));
      expect(result.kind).toBe("logic");
    });

    it("classifies a parse-failure message as logic", () => {
      const result = classifyError(new Error("Failed to parse patches: unterminated SEARCH block"));
      expect(result.kind).toBe("logic");
    });

    it("classifies an assertion-style message as logic", () => {
      const result = classifyError(new Error("assertion failed: expected true, got false"));
      expect(result.kind).toBe("logic");
    });
  });

  describe("boundary / unknown case (documented default)", () => {
    it("defaults an unrecognized Error message to logic", () => {
      const result = classifyError(new Error("something completely unrecognized happened"));
      expect(result.kind).toBe("logic");
      expect(result.reason).toContain("unclassified");
    });

    it("defaults a plain string (non-Error) to logic without throwing", () => {
      const result = classifyError("plain string error");
      expect(result.kind).toBe("logic");
    });

    it("defaults undefined to logic without throwing", () => {
      const result = classifyError(undefined);
      expect(result.kind).toBe("logic");
    });

    it("defaults null to logic without throwing", () => {
      const result = classifyError(null);
      expect(result.kind).toBe("logic");
    });

    it("defaults a plain object to logic without throwing", () => {
      const result = classifyError({ some: "object" });
      expect(result.kind).toBe("logic");
    });

    it("is deterministic: calling twice with the same input yields the same result", () => {
      const err = new Error("Network error");
      const first = classifyError(err);
      const second = classifyError(err);
      expect(first).toEqual(second);
    });

    it("always returns a non-empty reason string", () => {
      const result = classifyError(new Error("anything"));
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});
