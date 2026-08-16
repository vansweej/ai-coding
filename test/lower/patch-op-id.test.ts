import { describe, expect, it } from "bun:test";
import type { PatchOp } from "@ai-coding/shared";
import { lowerPatchOp, lowerPatchOps, mintOpId } from "../../src/lower/event-types";
import type { LoweredPatchOp } from "../../src/lower/event-types";

describe("mintOpId", () => {
  it("returns a non-empty string with op- prefix", () => {
    const id = mintOpId();
    expect(id).toMatch(/^op-[0-9a-z]+-[0-9a-z]+$/);
  });

  it("returns distinct values across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => mintOpId()));
    expect(ids.size).toBe(20);
  });
});

describe("lowerPatchOp", () => {
  it("stamps opId onto a create op", () => {
    const op: PatchOp = { kind: "create", filePath: "src/foo.ts", contents: "export {}" };
    const lowered = lowerPatchOp(op);
    expect(lowered.kind).toBe("create");
    expect(lowered.filePath).toBe("src/foo.ts");
    expect(lowered.opId).toMatch(/^op-/);
    expect(lowered.opId.length).toBeGreaterThan(0);
  });

  it("stamps opId onto an edit op", () => {
    const op: PatchOp = { kind: "edit", filePath: "src/foo.ts", search: "old", replace: "new" };
    const lowered = lowerPatchOp(op);
    expect(lowered.kind).toBe("edit");
    expect(lowered.opId).toMatch(/^op-/);
  });

  it("stamps opId onto a move op", () => {
    const op: PatchOp = { kind: "move", filePath: "src/old.ts", toPath: "src/new.ts" };
    const lowered = lowerPatchOp(op);
    expect(lowered.kind).toBe("move");
    expect(lowered.opId).toMatch(/^op-/);
  });

  it("each lowered op gets a unique opId", () => {
    const ops: PatchOp[] = [
      { kind: "create", filePath: "a.ts", contents: "" },
      { kind: "edit", filePath: "b.ts", search: "x", replace: "y" },
      { kind: "move", filePath: "c.ts", toPath: "d.ts" },
    ];
    const lowered = lowerPatchOps(ops);
    const ids = new Set(lowered.map((o) => o.opId));
    expect(ids.size).toBe(3);
  });

  it("opId field is present on all three variants via lowerPatchOps", () => {
    const ops: PatchOp[] = [
      { kind: "create", filePath: "a.ts", contents: "x" },
      { kind: "edit", filePath: "b.ts", search: "a", replace: "b" },
      { kind: "move", filePath: "c.ts", toPath: "d.ts" },
    ];
    const lowered: readonly LoweredPatchOp[] = lowerPatchOps(ops);
    for (const op of lowered) {
      expect(typeof op.opId).toBe("string");
      expect(op.opId.length).toBeGreaterThan(0);
    }
  });
});
