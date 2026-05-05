import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FileBackend } from "./file-backend";

const TMP_ROOT = "/tmp/opencode/file-backend-tests";

function makeSkill(root: string, name: string, content: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

function makeMarker(workspace: string, file: string): void {
  writeFileSync(join(workspace, file), "");
}

describe("FileBackend", () => {
  let skillRoot: string;
  let workspace: string;

  beforeEach(() => {
    skillRoot = join(TMP_ROOT, "skills");
    workspace = join(TMP_ROOT, "workspace");
    mkdirSync(skillRoot, { recursive: true });
    mkdirSync(workspace, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  it("resolves a single action skill when no workspace marker exists", async () => {
    makeSkill(skillRoot, "programmer", "# Programmer skill content");
    const backend = new FileBackend(skillRoot);
    const skills = await backend.resolve({ action: "edit", workspace });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("programmer");
    expect(skills[0]?.content).toBe("# Programmer skill content");
  });

  it("resolves action skill + workspace skill in correct order for rust", async () => {
    makeSkill(skillRoot, "programmer", "programmer content");
    makeSkill(skillRoot, "rust", "rust content");
    makeMarker(workspace, "Cargo.toml");

    const backend = new FileBackend(skillRoot);
    const skills = await backend.resolve({ action: "edit", workspace });

    expect(skills).toHaveLength(2);
    expect(skills[0]?.name).toBe("programmer");
    expect(skills[1]?.name).toBe("rust");
  });

  it("resolves action skill + workspace skill in correct order for cpp", async () => {
    makeSkill(skillRoot, "debugger", "debugger content");
    makeSkill(skillRoot, "cpp", "cpp content");
    makeMarker(workspace, "CMakeLists.txt");

    const backend = new FileBackend(skillRoot);
    const skills = await backend.resolve({ action: "debug", workspace });

    expect(skills).toHaveLength(2);
    expect(skills[0]?.name).toBe("debugger");
    expect(skills[1]?.name).toBe("cpp");
  });

  it("skips missing skill files without error", async () => {
    // programmer skill exists, rust skill does not
    makeSkill(skillRoot, "programmer", "programmer content");
    makeMarker(workspace, "Cargo.toml");

    const backend = new FileBackend(skillRoot);
    const skills = await backend.resolve({ action: "edit", workspace });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("programmer");
  });

  it("returns empty array when no skills map to the action and workspace", async () => {
    const backend = new FileBackend(skillRoot);
    const skills = await backend.resolve({ action: "chat", workspace });

    expect(skills).toHaveLength(0);
  });

  it("returns empty array when all mapped skills are missing from disk", async () => {
    const backend = new FileBackend(skillRoot);
    const skills = await backend.resolve({ action: "edit", workspace });

    expect(skills).toHaveLength(0);
  });

  it("resolves skills when workspace is undefined", async () => {
    makeSkill(skillRoot, "architect", "architect content");
    const backend = new FileBackend(skillRoot);
    const skills = await backend.resolve({ action: "plan" });

    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("architect");
  });

  it("resolved skill has undefined relevance (file backend does not score)", async () => {
    makeSkill(skillRoot, "programmer", "content");
    const backend = new FileBackend(skillRoot);
    const skills = await backend.resolve({ action: "edit" });

    expect(skills[0]?.relevance).toBeUndefined();
  });

  it("uses default skill root when no argument is provided", () => {
    // Verify the constructor accepts no arguments without throwing
    expect(() => new FileBackend()).not.toThrow();
  });
});
