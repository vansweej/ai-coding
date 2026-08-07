import type { PatchOp, Result } from "@ai-coding/shared";

import type { PatchEdit } from "../pipeline/steps/parse-patch";

/**
 * Dependency direction (hard rule): this module may import from
 * `@ai-coding/shared` (event-types.ts, which itself imports nothing) and
 * from `../pipeline/steps/parse-patch` (for the `PatchEdit` shape the
 * applier consumes). Neither of those modules may import back from here —
 * this file is a leaf that bridges the two, never the reverse.
 */

/**
 * Structural validation error for a raw value that does not match the
 * `{ ops: PatchOp[] }` wire shape.
 */
export interface PatchOpsParseError {
  readonly message: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validateOp(op: unknown, index: number): Result<PatchOp, PatchOpsParseError> {
  if (typeof op !== "object" || op === null) {
    return { ok: false, error: { message: `ops[${index}] is not an object` } };
  }

  const candidate = op as Record<string, unknown>;
  const { kind } = candidate;

  if (kind === "create") {
    if (!isNonEmptyString(candidate.filePath) || typeof candidate.contents !== "string") {
      return {
        ok: false,
        error: {
          message: `ops[${index}] (kind "create") requires a non-empty filePath and a contents string`,
        },
      };
    }
    return {
      ok: true,
      value: { kind: "create", filePath: candidate.filePath, contents: candidate.contents },
    };
  }

  if (kind === "move") {
    if (!isNonEmptyString(candidate.filePath) || !isNonEmptyString(candidate.toPath)) {
      return {
        ok: false,
        error: {
          message: `ops[${index}] (kind "move") requires a non-empty filePath and toPath`,
        },
      };
    }
    return {
      ok: true,
      value: { kind: "move", filePath: candidate.filePath, toPath: candidate.toPath },
    };
  }

  if (kind === "edit") {
    if (
      !isNonEmptyString(candidate.filePath) ||
      !isNonEmptyString(candidate.search) ||
      typeof candidate.replace !== "string"
    ) {
      return {
        ok: false,
        error: {
          message: `ops[${index}] (kind "edit") requires a non-empty filePath, a non-empty search, and a replace string`,
        },
      };
    }
    return {
      ok: true,
      value: {
        kind: "edit",
        filePath: candidate.filePath,
        search: candidate.search,
        replace: candidate.replace,
      },
    };
  }

  return {
    ok: false,
    error: { message: `ops[${index}] has an unknown kind: ${String(kind)}` },
  };
}

/**
 * Structurally validate an already-parsed JSON value against the
 * `{ ops: PatchOp[] }` wire shape. This is the guard for backends whose
 * "structured" output is actually JSON text (Ollama constrained decoding,
 * Copilot/Zen tool_calls arguments) rather than a natively-typed object
 * (Anthropic tool_use `input`).
 *
 * Does not perform path-safety checks or touch the filesystem —
 * `assertInsideWorkspace` (invoked from `applyPatch`) remains the sole
 * safety gate downstream.
 *
 * @param raw - An already-JSON.parsed value (never call this on a raw string).
 */
export function parsePatchOps(raw: unknown): Result<readonly PatchOp[], PatchOpsParseError> {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: { message: "expected an object with an 'ops' array" } };
  }

  const { ops } = raw as Record<string, unknown>;

  if (!Array.isArray(ops)) {
    return { ok: false, error: { message: "'ops' must be an array" } };
  }

  const validated: PatchOp[] = [];
  for (let index = 0; index < ops.length; index++) {
    const result = validateOp(ops[index], index);
    if (!result.ok) {
      return result;
    }
    validated.push(result.value);
  }

  return { ok: true, value: validated };
}

/**
 * Error when a `PatchOp` cannot be converted to a valid `PatchEdit`.
 */
export interface PatchOpConversionError {
  readonly message: string;
}

/**
 * Convert structured `PatchOp[]` (the wire shape a model emits) into the
 * `PatchEdit[]` shape the applier already consumes (see
 * ai-system/core/pipeline/steps/apply-patch-step.ts `applyPatch`). Does NOT
 * change the applier's verbs — this only feeds it. Does not perform
 * filesystem access or path-safety checks.
 */
export function patchOpsToEdits(
  ops: readonly PatchOp[],
): Result<readonly PatchEdit[], PatchOpConversionError> {
  const edits: PatchEdit[] = [];

  for (const op of ops) {
    if (op.kind === "create") {
      edits.push({
        filePath: op.filePath,
        search: "",
        replace: op.contents,
        isCreate: true,
        isMove: false,
      });
      continue;
    }

    if (op.kind === "move") {
      edits.push({
        filePath: op.filePath,
        toPath: op.toPath,
        search: "",
        replace: "",
        isCreate: false,
        isMove: true,
      });
      continue;
    }

    // op.kind === "edit"
    if (op.search === "") {
      return {
        ok: false,
        error: { message: `edit op for "${op.filePath}" has an empty search anchor` },
      };
    }

    edits.push({
      filePath: op.filePath,
      search: op.search,
      replace: op.replace,
      isCreate: false,
      isMove: false,
    });
  }

  return { ok: true, value: edits };
}
