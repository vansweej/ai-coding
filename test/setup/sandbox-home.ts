/* v8 ignore start */
/**
 * Global `bun test` safety net: redirects `HOME` to a throwaway temp
 * directory for the ENTIRE test process, before any test file loads.
 *
 * Why this exists: `resolveLedgerDir()` (src/ledger/ledger-writer.ts) reads
 * `process.env.HOME` directly (so per-test `beforeEach` overrides work --
 * Bun's `node:os` `homedir()` caches HOME at process startup and ignores
 * later mutations). Several pipeline code paths -- `restoreWorkingTree`,
 * `resetToPhaseCommit`, `createLedgerWriter` -- write real files under
 * `<HOME>/.local/share/ai-coding/` whenever a `runId` is present, including
 * auto-minted run ids from the real CLI entrypoint (`mintRunId()` in
 * `ai-system/cli/run-pipeline-cli.ts`) exercised by integration-style tests.
 * Without this preload, running the suite on a developer machine would
 * write real ledger/snapshot files into that developer's actual home
 * directory. This preload makes that structurally impossible: by the time
 * any test file's module-level code runs, `HOME` already points here.
 *
 * Per-test `beforeEach`/`afterEach` HOME overrides (e.g.
 * `ai-system/core/pipeline/snapshot.test.ts`) layer on top of this sandbox
 * value harmlessly -- they save/restore whatever `HOME` happens to be, so
 * this preload only changes what "the original value" is, never how those
 * tests behave.
 *
 * Test infrastructure, not application logic -- excluded from coverage like
 * `scripts/probe-copilot-toolcalls.ts`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxHome = mkdtempSync(join(tmpdir(), "ai-coding-test-home-"));
process.env.HOME = sandboxHome;

process.on("exit", () => {
  try {
    rmSync(sandboxHome, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; never throw during process exit.
  }
});
