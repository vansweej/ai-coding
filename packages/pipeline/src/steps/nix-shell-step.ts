import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Result } from "../pipeline-types";
import type { PipelineContext, PipelineStep, StepResult } from "../pipeline-types";
import { type ShellStepOptions, createShellStep } from "./shell-step";

/**
 * Creates a pipeline step that auto-detects a flake.nix in the working
 * directory and, if found, wraps the command in `nix develop --command`.
 * Falls back to running the command directly when no flake.nix is present.
 *
 * This allows the same pipeline definition to work in both nix-managed
 * environments (where tools live in the dev shell) and standard environments
 * (where tools are on PATH).
 *
 * Detection is performed once at step execution time, not at creation time,
 * so changing the working directory between steps is safe.
 *
 * @param name    - Unique step name, used as the key in PipelineContext.results.
 * @param command - Command and arguments as an array, e.g. ["cargo", "test"].
 * @param options - Optional cwd, timeout, and failure behaviour (same as ShellStep).
 */
export function createNixShellStep<TEvent = unknown>(
  name: string,
  command: readonly string[],
  options?: ShellStepOptions,
): PipelineStep<TEvent> {
  return {
    name,
    execute: async (ctx: PipelineContext<TEvent>): Promise<Result<StepResult>> => {
      const cwd = options?.cwd ?? process.cwd();
      const flakeExists = existsSync(join(cwd, "flake.nix"));

      const resolvedCommand = flakeExists
        ? (["nix", "develop", "--command", ...command] as const)
        : command;

      const delegate = createShellStep<TEvent>(name, resolvedCommand, options);
      return delegate.execute(ctx);
    },
  };
}
