import type { Result } from "@ai-coding/shared";

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
}

/**
 * Creates a pipeline step that runs a shell command via Bun.spawn.
 * Commands are passed as an array (never interpolated through a shell) to
 * prevent injection. The step does not interpret pipeline context -- it runs
 * a fixed command every time.
 *
 * @param name    - Unique step name, used as the key in PipelineContext.results.
 * @param command - Command and arguments as an array, e.g. ["bun", "test"].
 * @param options - Optional cwd, timeout, and failure behaviour.
 */
export function createShellStep(
  name: string,
  command: readonly string[],
  options?: ShellStepOptions,
): PipelineStep {
  const failOnNonZero = options?.failOnNonZero ?? true;
  const timeoutMs = options?.timeoutMs ?? 60_000;
  const cwd = options?.cwd;

  return {
    name,
    execute: async (_ctx: PipelineContext): Promise<Result<StepResult>> => {
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

        if (failOnNonZero && exitCode !== 0) {
          const detail = stderrText.trim() || stdoutText.trim();
          return {
            ok: false,
            error: new Error(
              `Shell step "${name}" exited with code ${exitCode}${detail ? `: ${detail}` : ""}`,
            ),
          };
        }

        return {
          ok: true,
          value: { stepName: name, output: stdoutText, durationMs },
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
