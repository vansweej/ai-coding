import type { Result } from "../pipeline-types";
import type { PipelineContext, PipelineStep, StepResult } from "../pipeline-types";

/** Options for configuring a ShellStep. */
export interface ShellStepOptions {
  /** Working directory for the command. Defaults to the current process cwd. */
  readonly cwd?: string;
  /** Maximum time to wait for the command in milliseconds. Defaults to 60000. */
  readonly timeoutMs?: number;
  /**
   * When true (default), a non-zero exit code causes the step to return an error.
   * Set to false to treat any exit code as success and capture output regardless.
   */
  readonly failOnNonZero?: boolean;
  /**
   * Optional callback fired exactly once per invocation with the real
   * captured output, regardless of pass/fail/soft-gate status -- fired
   * BEFORE the failOnNonZero branch decision, so a caller always learns the
   * true exit code and full stdout/stderr even when the step itself reports
   * success (failOnNonZero: false) or when it fails. Intended for
   * persisting a gate-output ledger line; this package intentionally takes
   * only primitive arguments so it never depends on ai-system's ledger/gate
   * types.
   */
  readonly onGateOutput?: (
    name: string,
    stdout: string,
    stderr: string,
    exitCode: number,
    durationMs: number,
  ) => void;
}

/**
 * Creates a pipeline step that runs a shell command via Bun.spawn.
 * Commands are passed as an array (never interpolated through a shell) to
 * prevent injection. The step does not read or write pipeline context -- it
 * runs the same fixed command on every invocation.
 * StepResult.output is the combined stdout and stderr text.
 *
 * @param name    - Unique step name, used as the key in PipelineContext.results.
 * @param command - Command and arguments as an array, e.g. ["bun", "test"].
 * @param options - Optional cwd, timeout, and failure behaviour.
 */
export function createShellStep<TEvent = unknown>(
  name: string,
  command: readonly string[],
  options?: ShellStepOptions,
): PipelineStep<TEvent> {
  const failOnNonZero = options?.failOnNonZero ?? true;
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const cwd = options?.cwd;

  return {
    name,
    execute: async (_ctx: PipelineContext<TEvent>): Promise<Result<StepResult>> => {
      const startedAt = Date.now();

      const proc = Bun.spawn(command as string[], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => {
          proc.kill();
          reject(new Error(`Shell step "${name}" timed out after ${timeoutMs}ms`));
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

        const durationMs = Date.now() - startedAt;

        options?.onGateOutput?.(name, stdoutText, stderrText, exitCode, durationMs);

        if (failOnNonZero && exitCode !== 0) {
          const detail = stderrText.trim() || stdoutText.trim();
          return {
            ok: false,
            error: new Error(
              `Shell step "${name}" exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
            ),
          };
        }

        // Combine stdout and stderr into the step output. Some toolchains
        // (e.g. cargo tarpaulin) emit their summary via their tracing
        // logger on stderr rather than stdout. The coverage gate step is
        // the only downstream consumer that parses a shell step's output;
        // every other toolchain step (fmt/check/clippy/test) signals
        // pass/fail purely via exit code, so combining is safe.
        const output = [stdoutText, stderrText].filter((s) => s.trim().length > 0).join("\n");

        return {
          ok: true,
          value: { stepName: name, output, durationMs },
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  };
}
