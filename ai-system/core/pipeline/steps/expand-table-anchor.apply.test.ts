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

describe("apply-time on-disk anchor reconciliation (field-shape regression)", () => {
  it("applies a MOVE, then an append-same-header body mutation, then a [lints.clippy] rename in one batch with no dangling body", async () => {
    const tempDir = mkdtempSync(join("/tmp", "expand-table-anchor-field-shape-test-"));
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
        // Append-same-header body mutation: same canonical header on both
        // sides of the edit, so this is NOT a table-header rename -- it must
        // pass through the expansion pass unexpanded and simply appends a
        // key to the on-disk table body.
        {
          filePath: "crates/parlang/Cargo.toml",
          search: "[lints.clippy]",
          replace: '[lints.clippy]\nextra = "warn"',
          isCreate: false,
          isMove: false,
        },
        // The confirmed table-header rename targeting the SAME file, in the
        // SAME batch, immediately after the append above.
        {
          filePath: "crates/parlang/Cargo.toml",
          search: "[lints.clippy]",
          replace: "[lints]\nworkspace = true",
          isCreate: false,
          isMove: false,
        },
      ];

      const coerced = coerceCreatesToEdits(tempDir, edits);

      // FIELD-SHAPE DIVERGENCE LOCUS: production (`tryStructuredPhase`) no
      // longer runs an up-front `expandTableHeaderAnchors` pass at all -- it
      // calls `applyPatch` directly with `{ expandTableAnchors: true }`,
      // which derives the confirmed table-header rename anchor
      // authoritatively from the bytes just read from disk for THAT edit,
      // reflecting every preceding edit/move already applied earlier in this
      // same sequential batch (the move, then the append). Prior to this
      // fix, the only expansion available ran up front against PREDICTED
      // in-batch content that did not reflect the preceding append edit's
      // on-disk effect, so the expanded anchor missed at apply time
      // (`applyPatch` returned `{ ok: false, reason: "not-found" }` with
      // message containing "Search anchor not found" -- the exact
      // `apply-failed` StructuredDecline class reported from the field, NOT
      // `anchor-unexpandable`).
      const applied = await applyPatch(tempDir, coerced, { expandTableAnchors: true });

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
      expect(finalContent).not.toContain("extra");

      const lintsIdx = finalContent.indexOf("[lints]");
      const nextHeaderIdx = finalContent.indexOf("[dependencies]");
      const lintsBlock = finalContent.slice(lintsIdx, nextHeaderIdx).trim();
      expect(lintsBlock).toBe("[lints]\nworkspace = true");

      expect(finalContent.endsWith("\n")).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("applies an append-same-header body mutation then a [lints.clippy] rename in one batch, no move", async () => {
    const tempDir = mkdtempSync(join("/tmp", "expand-table-anchor-reduced-shape-test-"));
    try {
      const cargoTomlPath = join(tempDir, "Cargo.toml");
      const original =
        '[package]\nname = "parlang"\n\n[lints.clippy]\npedantic = "warn"\nmodule_name_repetitions = "allow"\nmust_use_candidate = "allow"\n\n[dependencies]\nserde = "1"\n';
      writeFileSync(cargoTomlPath, original, "utf8");

      const edits: PatchEdit[] = [
        {
          filePath: "Cargo.toml",
          search: "[lints.clippy]",
          replace: '[lints.clippy]\nextra = "warn"',
          isCreate: false,
          isMove: false,
        },
        {
          filePath: "Cargo.toml",
          search: "[lints.clippy]",
          replace: "[lints]\nworkspace = true",
          isCreate: false,
          isMove: false,
        },
      ];

      const applied = await applyPatch(tempDir, edits, { expandTableAnchors: true });
      expect(applied.ok).toBe(true);

      const finalContent = readFileSync(cargoTomlPath, "utf8");

      expect(finalContent).toContain("[lints]\nworkspace = true");
      expect(finalContent).not.toContain("pedantic");
      expect(finalContent).not.toContain("module_name_repetitions");
      expect(finalContent).not.toContain("must_use_candidate");
      expect(finalContent).not.toContain("extra");

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
