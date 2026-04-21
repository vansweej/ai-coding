import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";

import type { PipelineContext, PipelineStep, Result, StepResult } from "../pipeline-types";
import { parseCodeBlocks } from "./parse-code-blocks";

/** Options for the file writer step. */
export interface FileWriterStepOptions {
  /** Name of the prior step whose output contains fenced code blocks. */
  readonly readFrom: string;
  /** Root directory under which all files are written. */
  readonly baseDir: string;
  /**
   * Whether to overwrite files that already exist.
   * @default true
   */
  readonly overwrite?: boolean;
}

/**
 * Validate that a file path is safe to write relative to a base directory.
 *
 * Rejects absolute paths and paths that escape the base directory via `..`.
 */
function validateRelativePath(filePath: string, baseDir: string): Result<string> {
  if (isAbsolute(filePath)) {
    return { ok: false, error: new Error(`Unsafe file path: "${filePath}" must be relative`) };
  }
  const resolved = normalize(join(baseDir, filePath));
  const normalizedBase = normalize(baseDir);
  if (!resolved.startsWith(`${normalizedBase}/`)) {
    return {
      ok: false,
      error: new Error(`Unsafe file path: "${filePath}" escapes the base directory`),
    };
  }
  return { ok: true, value: resolved };
}

/**
 * Create a pipeline step that reads fenced code blocks from a prior step's
 * output and writes each block to disk under `baseDir`.
 *
 * The expected code block format is:
 * ```<language> <file-path>
 * <content>
 * ```
 *
 * Blocks without a file path in the info string are silently skipped.
 * The step fails if no writable blocks are found.
 *
 * @param name    - Step name (must be unique within the pipeline).
 * @param options - Configuration: which step to read from, base directory, overwrite flag.
 */
export function createFileWriterStep<TEvent = unknown>(
  name: string,
  options: FileWriterStepOptions,
): PipelineStep<TEvent> {
  const overwrite = options.overwrite ?? true;

  return {
    name,
    execute: async (ctx: PipelineContext<TEvent>): Promise<Result<StepResult>> => {
      const startedAt = Date.now();

      const priorResult = ctx.results.get(options.readFrom);
      if (priorResult === undefined) {
        return {
          ok: false,
          error: new Error(
            `File writer step "${name}": step "${options.readFrom}" not found in context`,
          ),
        };
      }

      const blocks = parseCodeBlocks(priorResult.output);
      if (blocks.length === 0) {
        return {
          ok: false,
          error: new Error(
            `File writer step "${name}": no fenced code blocks with file paths found in output of step "${options.readFrom}"`,
          ),
        };
      }

      const writtenPaths: string[] = [];

      for (const block of blocks) {
        const validation = validateRelativePath(block.filePath, options.baseDir);
        if (!validation.ok) {
          return validation;
        }
        const absolutePath = validation.value;

        if (!overwrite && existsSync(absolutePath)) {
          continue;
        }

        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, block.content, "utf8");
        writtenPaths.push(block.filePath);
      }

      const count = writtenPaths.length;
      const summary =
        count === 0
          ? "No files written (all already exist and overwrite is disabled)"
          : `Wrote ${count} file${count === 1 ? "" : "s"}: ${writtenPaths.join(", ")}`;

      return {
        ok: true,
        value: { stepName: name, output: summary, durationMs: Date.now() - startedAt },
      };
    },
  };
}
