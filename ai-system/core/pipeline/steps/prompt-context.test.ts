import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  isGeneratedPath,
  referencedFiles,
  renderBoundedFileContents,
  selectContextFiles,
} from "./prompt-context";

let workspace: string;

function writeWorkspaceFile(path: string, contents = "contents\n"): void {
  const filePath = join(workspace, path);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, contents);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "prompt-context-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("referencedFiles", () => {
  it("returns a regular file mentioned in the instruction", () => {
    writeWorkspaceFile("src/x.ts");

    expect(referencedFiles(workspace, "Update src/x.ts")).toEqual(["src/x.ts"]);
  });

  it("strips trailing sentence punctuation", () => {
    writeWorkspaceFile("src/x.ts");

    expect(referencedFiles(workspace, "Update src/x.ts.")).toEqual(["src/x.ts"]);
  });

  it("ignores a directory token", () => {
    mkdirSync(join(workspace, "src"), { recursive: true });

    expect(referencedFiles(workspace, "Update src")).toEqual([]);
  });

  it("ignores an absolute path outside the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "prompt-context-outside-"));
    try {
      const outsideFile = join(outside, "x.ts");
      writeFileSync(outsideFile, "outside\n");

      expect(referencedFiles(workspace, `Update ${outsideFile}`)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("ignores a ../escape token", () => {
    expect(referencedFiles(workspace, "Update ../escape")).toEqual([]);
  });
});

describe("isGeneratedPath", () => {
  it("identifies lockfiles and node_modules paths", () => {
    expect(isGeneratedPath("bun.lock")).toBe(true);
    expect(isGeneratedPath("node_modules/pkg/index.js")).toBe(true);
    expect(isGeneratedPath("src/x.ts")).toBe(false);
  });
});

describe("selectContextFiles", () => {
  it("returns no files for an untouched workspace with no references", () => {
    expect(selectContextFiles(workspace, "Update nothing")).toEqual([]);
  });

  it("orders a referenced file before another touched file", () => {
    writeWorkspaceFile("src/named.ts");
    writeWorkspaceFile("src/other.ts");

    expect(selectContextFiles(workspace, "Update src/named.ts")).toEqual([
      "src/named.ts",
      "src/other.ts",
    ]);
  });

  it("excludes touched lockfiles unless the instruction names them", () => {
    writeWorkspaceFile("bun.lock");

    expect(selectContextFiles(workspace, "Update dependencies")).toEqual([]);
    expect(selectContextFiles(workspace, "Update bun.lock")).toEqual(["bun.lock"]);
  });
});

describe("renderBoundedFileContents", () => {
  it("returns an empty string when the selection is empty", () => {
    expect(renderBoundedFileContents(workspace, "Update nothing")).toBe("");
  });

  it("includes referenced file content under the current-file header", () => {
    writeWorkspaceFile("src/x.ts", "export const value = 1;\n");

    const rendered = renderBoundedFileContents(workspace, "Update src/x.ts");

    expect(rendered).toContain("Current file contents:");
    expect(rendered).toContain("export const value = 1;");
  });

  it("spends a tight total budget on the named file before other touched files", () => {
    writeWorkspaceFile("src/named.ts", "named file contents\n");
    writeWorkspaceFile("src/other.ts", "other file contents\n");

    const rendered = renderBoundedFileContents(workspace, "Update src/named.ts", {
      totalBudget: 1,
    });

    expect(rendered).toContain("named file contents");
    expect(rendered).not.toContain("other file contents");
  });

  it("truncates a large selected file with a non-ellipsis marker", () => {
    writeWorkspaceFile("src/x.ts", "abcdefghij");

    const rendered = renderBoundedFileContents(workspace, "Update src/x.ts", { perFileCap: 3 });

    expect(rendered).toContain("[ai-coding: truncated");
    expect(rendered).not.toContain("...");
  });
});
