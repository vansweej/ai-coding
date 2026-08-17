import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Result } from "../pipeline-types";

/** Options for configuring devShellPalette detection. */
export interface DevShellPaletteOptions {
  /** Working directory to probe. Defaults to the current process cwd. */
  readonly cwd?: string;
  /**
   * Maximum time to wait for the probe in milliseconds. Defaults to 60000
   * for a bare-PATH probe, or 300000 when a flake.nix is present (a cold
   * flake-based devShell realization -- e.g. a Rust toolchain via
   * rust-overlay/oxalica plus cargo-tarpaulin -- can legitimately take
   * several minutes on first evaluation; a 60s timeout was previously
   * observed to under-report a driver tool like `cargo` while the probe
   * process itself still exited 0, silently producing a palette that
   * omitted a tool that WAS actually present -- see the mapped-but-
   * unavailable false-green this timeout increase and the shell warm-up
   * below both defend against).
   */
  readonly timeoutMs?: number;
}

/** Default probe timeout when no flake.nix is present (bare PATH probe). */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Default probe timeout when a flake.nix IS present. Deliberately much
 * higher than {@link DEFAULT_TIMEOUT_MS}: a cold `nix develop` realization
 * of a non-trivial devShell (compilers, toolchains, cargo-tarpaulin, etc.)
 * can take minutes on first invocation. Still overridable via
 * {@link DevShellPaletteOptions.timeoutMs}.
 */
const DEFAULT_FLAKE_TIMEOUT_MS = 300_000;

/**
 * Best-effort warm-up: realizes the flake's devShell (`nix develop
 * --command true`) BEFORE the actual `command -v` probe runs, so the probe
 * itself only has to enter an already-realized shell rather than race a
 * cold Nix evaluation within its own timeout window. Never throws and never
 * fails the caller -- a warm-up failure (or timeout) is silently ignored;
 * the real probe below still runs and is the sole source of truth. This is
 * defense-in-depth only, not a correctness guarantee on its own.
 */
async function warmDevShell(cwd: string, timeoutMs: number): Promise<void> {
  try {
    const proc = Bun.spawn(["nix", "develop", "--command", "true"], {
      cwd,
      stdout: "ignore",
      stderr: "ignore",
    });
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill();
        resolve();
      }, timeoutMs);
      proc.exited.finally(() => clearTimeout(timer));
    });
    await Promise.race([proc.exited.then(() => undefined), timeout]);
  } catch {
    // Best-effort only -- the real probe below is authoritative.
  }
}

/**
 * Detects which of the given candidate tools are actually invocable in the
 * workspace's dev environment.
 *
 * Mirrors the flake-detection branch used by {@link createNixShellStep}:
 * when a flake.nix is present, the probe runs inside `nix develop --command`
 * so it reflects the tools a devShell actually provides; otherwise it probes
 * the bare ambient PATH via `sh -c`. Either way the mechanism is a single
 * bounded `command -v` loop over the candidate list -- never static parsing
 * of flake.nix (which is brittle to `with pkgs; [...]` vs `[pkgs.x]` syntax,
 * overlays, and custom derivations), and never a per-tool subprocess.
 *
 * Output parsing is intentionally a WHITELIST intersection against
 * `candidateTools`, not a blind split of every stdout line. Some devShells
 * emit extra lines via a shellHook (e.g. a welcome banner) that interleave
 * with the probe's own echoed tool names on the same stdout stream; treating
 * every line as a detected tool would misreport those banner lines as tools.
 *
 * A broken flake.nix (one `nix develop` itself cannot evaluate) fails fast
 * with a non-zero exit before any candidate is probed -- this surfaces as
 * Err, which callers should treat as a broken-environment condition rather
 * than retrying with an LLM call.
 *
 * @param workspace      - Absolute path to the workspace to probe.
 * @param candidateTools - Tool binary names to check for, e.g. ["cargo", "bun"].
 * @param options        - Optional cwd override, and timeout.
 */
export async function devShellPalette(
  workspace: string,
  candidateTools: readonly string[],
  options?: DevShellPaletteOptions,
): Promise<Result<Set<string>>> {
  const cwd = options?.cwd ?? workspace;
  const flakeExists = existsSync(join(cwd, "flake.nix"));
  const timeoutMs =
    options?.timeoutMs ?? (flakeExists ? DEFAULT_FLAKE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  if (candidateTools.length === 0) {
    return { ok: true, value: new Set() };
  }

  // Best-effort warm-up: realize the devShell before probing so the probe
  // itself races a warm shell, not a cold Nix evaluation, reducing the
  // chance it under-reports a driver tool within its own timeout window.
  if (flakeExists) {
    await warmDevShell(cwd, timeoutMs);
  }

  // The script's own exit code must not depend on whether the LAST
  // candidate happens to be found: `command -v` on a missing tool exits
  // non-zero, and a shell script's exit code is that of its last command.
  // Force exit 0 explicitly so probe success reflects "the loop ran", not
  // "the last candidate happened to be present".
  const probeScript = `for t in ${candidateTools.map((t) => `"${t}"`).join(" ")}; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; exit 0`;

  const command = flakeExists
    ? (["nix", "develop", "--command", "sh", "-c", probeScript] as const)
    : (["sh", "-c", probeScript] as const);

  const proc = Bun.spawn(command as unknown as string[], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new Error(`devShellPalette probe timed out after ${timeoutMs}ms`));
    }, timeoutMs),
  );

  try {
    const [exitCode, stdoutText, stderrText] = await Promise.race([
      Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]),
      timeout,
    ]);

    if (exitCode !== 0) {
      const detail = stderrText.trim() || stdoutText.trim();
      return {
        ok: false,
        error: new Error(
          `devShellPalette probe exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
        ),
      };
    }

    const candidateSet = new Set(candidateTools);
    const detected = new Set(
      stdoutText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => candidateSet.has(line)),
    );

    return { ok: true, value: detected };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
