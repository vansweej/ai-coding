import type { PatchOp } from "@ai-coding/shared";
import { mintRunId } from "../run/run-id";

/**
 * A `PatchOp` augmented with a per-op correlation id (`opId`).
 *
 * `opId` is unique within a run and serves as the correlation key between:
 *   - the patch op that was applied
 *   - the gate-output ledger line emitted after verification of that op
 *
 * All three PatchOp variants (create / edit / move) carry an `opId`.
 */
export type LoweredPatchOp = PatchOp & { readonly opId: string };

/**
 * Mint a unique op id.
 * Format: `op-<timestamp-ms>-<uuid-suffix>` — no external dependencies.
 * Reuses the same minting strategy as `mintRunId` for consistency.
 */
export function mintOpId(): string {
  // mintRunId produces `run-<ts>-<suffix>`; we swap the prefix for `op-`
  return mintRunId().replace(/^run-/, "op-");
}

/**
 * Lower a `PatchOp` to a `LoweredPatchOp` by stamping a fresh `opId`.
 * Called once per op at construction time; the id is stable for the op's lifetime.
 */
export function lowerPatchOp(op: PatchOp): LoweredPatchOp {
  return { ...op, opId: mintOpId() };
}

/**
 * Lower an array of `PatchOp`s, stamping each with a unique `opId`.
 */
export function lowerPatchOps(ops: readonly PatchOp[]): readonly LoweredPatchOp[] {
  return ops.map(lowerPatchOp);
}
