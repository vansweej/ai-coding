import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyPatch } from "./apply-patch-step";
import { coerceCreatesToEdits } from "./coerce-create-to-edit";
import { expandTableHeaderAnchors } from "./expand-table-anchor";
import type { PatchEdit } from "./parse-patch";

describe("expandTableHeaderAnchors + applyPatch (end-to-end regression)", () => {
  it("expands a narrow [lints.clippy] anchor so the applied [lints] table has no dangling body", async () => {
    const tempDir = mkdtempSync(join("/tmp", "expand-table-anchor-apply-test-"));
    try {
      const cargoTomlPath = join(tempDir, "Cargo.toml");
      const original =
        '[package]\nname = "parlang"\n\n[lints.clippy]\npedantic = "warn"\nmodule_name_repetitions = "allow"\nmust_use_candidate = "allow"\n\n[dependencies]\nserde = "1"\n';
      writeFileSync(cargoTomlPath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search: "[lints.clippy]",
          replace: "[lints]\nworkspace = true",
          isCreate: false,
          isMove: false,
        },
      ];

      const expandResult = expandTableHeaderAnchors(tempDir, edits);
      expect(expandResult.ok).toBe(true);
      if (!expandResult.ok) throw new Error("expected ok");
      const applyResult = await applyPatch(tempDir, expandResult.value);

      expect(applyResult.ok).toBe(true);

      const finalContent = readFileSync(cargoTomlPath, "utf8");

      expect(finalContent).toContain("[lints]\nworkspace = true");
      expect(finalContent).not.toContain("pedantic");
      expect(finalContent).not.toContain("module_name_repetitions");
      expect(finalContent).not.toContain("must_use_candidate");

      // The [lints] table's body is exactly `workspace = true` -- verify no
      // dangling content sits between it and the next table header.
      const lintsIdx = finalContent.indexOf("[lints]");
      const nextHeaderIdx = finalContent.indexOf("[dependencies]");
      const lintsBlock = finalContent.slice(lintsIdx, nextHeaderIdx).trim();
      expect(lintsBlock).toBe("[lints]\nworkspace = true");

      // Trailing final newline is preserved after apply.
      expect(finalContent.endsWith("\n")).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("applies a MOVE then a narrow [lints.clippy] edit with no dangling body and no Search anchor not found", async () => {
    const tempDir = mkdtempSync(join("/tmp", "expand-table-anchor-apply-move-test-"));
    try {
      const cargoTomlPath = join(tempDir, "Cargo.toml");
      const original =
        '[package]\nname = "parlang"\n\n[lints.clippy]\npedantic = "warn"\nmodule_name_repetitions = "allow"\nmust_use_candidate = "allow"\n\n[dependencies]\nserde = "1"\n';
      writeFileSync(cargoTomlPath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          toPath: "crates/parlang/Cargo.toml",
          search: "",
          replace: "",
          isCreate: false,
          isMove: true,
        },
        {
          filePath: "crates/parlang/Cargo.toml",
          search: "[lints.clippy]",
          replace: "[lints]\nworkspace = true",
          isCreate: false,
          isMove: false,
        },
      ];

      const expandResult = expandTableHeaderAnchors(tempDir, coerceCreatesToEdits(tempDir, edits));
      expect(expandResult.ok).toBe(true);
      if (!expandResult.ok) throw new Error("expected ok");
      const applied = await applyPatch(tempDir, expandResult.value);

      expect(applied.ok).toBe(true);

      let sourceExists = true;
      try {
        readFileSync(join(tempDir, "Cargo.toml"), "utf8");
      } catch {
        sourceExists = false;
      }
      expect(sourceExists).toBe(false);

      const movedPath = join(tempDir, "crates", "parlang", "Cargo.toml");
      const finalContent = readFileSync(movedPath, "utf8");

      expect(finalContent).toContain("[lints]\nworkspace = true");
      expect(finalContent).not.toContain("pedantic");
      expect(finalContent).not.toContain("module_name_repetitions");
      expect(finalContent).not.toContain("must_use_candidate");

      const lintsIdx = finalContent.indexOf("[lints]");
      const nextHeaderIdx = finalContent.indexOf("[dependencies]");
      const lintsBlock = finalContent.slice(lintsIdx, nextHeaderIdx).trim();
      expect(lintsBlock).toBe("[lints]\nworkspace = true");

      expect(finalContent.endsWith("\n")).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
