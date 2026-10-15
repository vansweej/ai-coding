import { describe, expect, it } from "bun:test";

import { renderAssertion } from "./phase-assertions";

describe("renderAssertion", () => {
  it("renders contains assertions", () => {
    expect(renderAssertion({ kind: "contains", path: "src/x.ts", needle: "needle" })).toBe(
      "Assert: contains src/x.ts :: needle",
    );
  });

  it("renders not-contains assertions", () => {
    expect(renderAssertion({ kind: "not-contains", path: "src/x.ts", needle: "needle" })).toBe(
      "Assert: not-contains src/x.ts :: needle",
    );
  });

  it("renders exists assertions", () => {
    expect(renderAssertion({ kind: "exists", path: "src/x.ts" })).toBe("Assert: exists src/x.ts");
  });

  it("renders not-exists assertions", () => {
    expect(renderAssertion({ kind: "not-exists", path: "src/x.ts" })).toBe(
      "Assert: not-exists src/x.ts",
    );
  });

  it("renders matches assertions", () => {
    expect(renderAssertion({ kind: "matches", path: "src/x.ts", pattern: "needle" })).toBe(
      "Assert: matches src/x.ts :: needle",
    );
  });

  it("renders toml-keys assertions", () => {
    expect(
      renderAssertion({
        kind: "toml-keys",
        path: "Cargo.toml",
        table: "lints.workspace",
        keys: ["foo", "bar"],
      }),
    ).toBe("Assert: toml-keys Cargo.toml :: lints.workspace :: foo,bar");
  });

  it("renders test-passes assertions", () => {
    expect(renderAssertion({ kind: "test-passes", path: "src/x.test.ts" })).toStartWith(
      "Assert: test ",
    );
  });
});
