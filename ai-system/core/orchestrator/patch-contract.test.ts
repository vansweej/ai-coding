import { describe, expect, it } from "bun:test";

import { PATCH_OPS_JSON_SCHEMA, PATCH_TOOL_NAME } from "@ai-coding/shared";

import { parsePatchOps, patchOpsToEdits } from "./patch-contract";

describe("parsePatchOps", () => {
  it("accepts a valid create op", () => {
    const result = parsePatchOps({
      ops: [{ kind: "create", filePath: "src/new.ts", contents: "export {}" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { kind: "create", filePath: "src/new.ts", contents: "export {}" },
      ]);
    }
  });

  it("accepts a valid move op", () => {
    const result = parsePatchOps({
      ops: [{ kind: "move", filePath: "src/old.ts", toPath: "src/new.ts" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { kind: "move", filePath: "src/old.ts", toPath: "src/new.ts" },
      ]);
    }
  });

  it("accepts a valid edit op", () => {
    const result = parsePatchOps({
      ops: [{ kind: "edit", filePath: "src/a.ts", search: "foo", replace: "bar" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        { kind: "edit", filePath: "src/a.ts", search: "foo", replace: "bar" },
      ]);
    }
  });

  it("accepts multiple ops of mixed kinds", () => {
    const result = parsePatchOps({
      ops: [
        { kind: "create", filePath: "a.ts", contents: "" },
        { kind: "move", filePath: "b.ts", toPath: "c.ts" },
        { kind: "edit", filePath: "d.ts", search: "x", replace: "y" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
    }
  });

  it("rejects a non-object input", () => {
    const result = parsePatchOps("not an object");
    expect(result.ok).toBe(false);
  });

  it("rejects null", () => {
    const result = parsePatchOps(null);
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array ops field", () => {
    const result = parsePatchOps({ ops: "not-an-array" });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown kind", () => {
    const result = parsePatchOps({ ops: [{ kind: "delete", filePath: "a.ts" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("unknown kind");
    }
  });

  it("rejects a create op missing contents", () => {
    const result = parsePatchOps({ ops: [{ kind: "create", filePath: "a.ts" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects a create op with an empty filePath", () => {
    const result = parsePatchOps({ ops: [{ kind: "create", filePath: "", contents: "x" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects a move op missing toPath", () => {
    const result = parsePatchOps({ ops: [{ kind: "move", filePath: "a.ts" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects an edit op missing search", () => {
    const result = parsePatchOps({ ops: [{ kind: "edit", filePath: "a.ts", replace: "y" }] });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object element inside ops", () => {
    const result = parsePatchOps({ ops: [null] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ops[0]");
    }
  });
});

describe("patchOpsToEdits", () => {
  it("converts a create op to the applier's isCreate flag shape", () => {
    const result = patchOpsToEdits([
      { kind: "create", filePath: "src/new.ts", contents: "export {}" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          filePath: "src/new.ts",
          search: "",
          replace: "export {}",
          isCreate: true,
          isMove: false,
        },
      ]);
    }
  });

  it("converts a move op to the applier's isMove flag shape", () => {
    const result = patchOpsToEdits([{ kind: "move", filePath: "a.ts", toPath: "b.ts" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          filePath: "a.ts",
          toPath: "b.ts",
          search: "",
          replace: "",
          isCreate: false,
          isMove: true,
        },
      ]);
    }
  });

  it("converts an edit op to the applier's anchor-edit flag shape", () => {
    const result = patchOpsToEdits([
      { kind: "edit", filePath: "a.ts", search: "foo", replace: "bar" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([
        {
          filePath: "a.ts",
          search: "foo",
          replace: "bar",
          isCreate: false,
          isMove: false,
        },
      ]);
    }
  });

  it("converts multiple ops preserving order", () => {
    const result = patchOpsToEdits([
      { kind: "create", filePath: "a.ts", contents: "1" },
      { kind: "edit", filePath: "b.ts", search: "x", replace: "y" },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.isCreate).toBe(true);
      expect(result.value[1]?.isCreate).toBe(false);
    }
  });

  it("rejects an edit op with an empty search anchor", () => {
    const result = patchOpsToEdits([{ kind: "edit", filePath: "a.ts", search: "", replace: "y" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty search anchor");
    }
  });
});

describe("PATCH_TOOL_NAME and PATCH_OPS_JSON_SCHEMA", () => {
  it("names the forced tool emit_patch", () => {
    expect(PATCH_TOOL_NAME).toBe("emit_patch");
  });

  it("declares all three kind branches in the schema", () => {
    const schema = PATCH_OPS_JSON_SCHEMA as {
      properties: { ops: { items: { oneOf: Array<{ properties: { kind: { const: string } } }> } } };
    };
    const kinds = schema.properties.ops.items.oneOf.map((branch) => branch.properties.kind.const);
    expect(kinds.sort()).toEqual(["create", "edit", "move"]);
  });
});
