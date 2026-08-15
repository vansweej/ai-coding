/**
 * Doctor subcommand: dynamically imports a fixed hardcoded list of entrypoint
 * specifiers and reports any that fail to import, without calling any I/O
 * functions (no config load, no dispatch invocation).
 */

/** A single import failure collected during the doctor run. */
export interface DoctorFailure {
  readonly specifier: string;
  readonly message: string;
}

/** Result returned by {@link runDoctorSandboxed}. */
export interface DoctorResult {
  readonly ok: boolean;
  readonly failures: readonly DoctorFailure[];
}

/**
 * The fixed hardcoded list of entrypoint specifiers that the doctor checks.
 * NEVER use a glob or readdir/directory-scan here — those would hit impure
 * modules (cli/*.ts, indexer/cli.ts) that have top-level I/O.
 */
const ENTRYPOINTS: readonly string[] = [
  "@ai-coding/embeddings",
  "@ai-coding/pipeline",
  "@ai-coding/skills",
  "@ai-coding/codebase",
  "../core/pipeline/feature-runner",
  "../core/pipeline/phase-runner",
  "../cli/select-pipeline",
  "../cli/load-config",
  "../config/model-profiles",
  "../config/pipeline-registry",
];

/**
 * Dynamically imports each entrypoint in {@link ENTRYPOINTS} and collects any
 * that fail. The import-purity audit confirmed all of these are safe to import
 * offline: network/token/probe I/O is call-time only; native libs only dlopen
 * inert binaries at import time.
 *
 * MUST NOT call `loadConfig()`, MUST NOT invoke the dispatch layer, and MUST
 * NOT use any glob/readdir/directory-scan walker.
 *
 * @returns `{ ok: true, failures: [] }` when every import succeeds, or
 *   `{ ok: false, failures: [...] }` listing each specifier that threw.
 */
export async function runDoctorSandboxed(): Promise<DoctorResult> {
  const failures: DoctorFailure[] = [];

  for (const specifier of ENTRYPOINTS) {
    try {
      await import(specifier);
    } catch (err) {
      failures.push({
        specifier,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { ok: failures.length === 0, failures };
}