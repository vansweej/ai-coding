/**
 * Run correlation id — minted once per plan-cycle invocation.
 *
 * The id is stable for the lifetime of one run and serves as the primary
 * correlation key for:
 *   - every line in the JSON-lines ledger file
 *   - the `Run-Id:` git commit trailer on every phase commit
 *   - the `CHORAGOS-LEDGER runId=<id> path=<abs>` stdout locator
 */
export type RunId = string;

/**
 * Mint a new collision-resistant run id.
 * Format: `run-<timestamp-ms>-<uuid-suffix>` — no external dependencies.
 */
export function mintRunId(): RunId {
  const ts = Date.now().toString(36);
  const uuid = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `run-${ts}-${uuid}`;
}
