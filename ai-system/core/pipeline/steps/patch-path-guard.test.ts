import { describe, expect, it } from "bun:test";
import { assertInsideWorkspace } from "./patch-path-guard";

describe("assertInsideWorkspace", () => {
  const root = "/home/user/project";

  it("allows relative paths within the workspace", () => {
    const result = assertInsideWorkspace(root, "src/main.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value).toContain("src/main.ts");
  });

  it("allows paths with nested directories", () => {
    const result = assertInsideWorkspace(root, "src/nested/deep/file.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value).toContain("src/nested/deep/file.ts");
  });

  it("rejects absolute paths", () => {
    const result = assertInsideWorkspace(root, "/etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error.message).toContain("must be relative");
  });

  it("rejects paths that escape via ../", () => {
    const result = assertInsideWorkspace(root, "../../../etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error.message).toContain("escapes the workspace root");
  });

  it("rejects paths with ../ in the middle", () => {
    const result = assertInsideWorkspace(root, "src/../../../etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");
    expect(result.error.message).toContain("escapes the workspace root");
  });

  it("allows paths with ./ prefix", () => {
    const result = assertInsideWorkspace(root, "./src/main.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value).toContain("src/main.ts");
  });

  it("returns the resolved absolute path", () => {
    const result = assertInsideWorkspace(root, "src/main.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value).toBe("/home/user/project/src/main.ts");
  });

  it("normalizes paths with redundant separators", () => {
    const result = assertInsideWorkspace(root, "src//main.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value).toBe("/home/user/project/src/main.ts");
  });
});
