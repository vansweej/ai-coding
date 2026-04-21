import type { Result } from "../pipeline-types";
import type { PipelineContext, PipelineStep, StepResult } from "../pipeline-types";

/**
 * Default regex that matches tarpaulin's text output:
 *   "87.50% coverage, 35/40 lines covered"
 * and common formats like "Coverage: 92.30%".
 */
const DEFAULT_COVERAGE_PATTERN = /(\d+\.?\d*)%\s*coverage/i;

/**
 * Creates a pipeline step that reads a prior step's output, extracts a
 * coverage percentage using a regex pattern, and fails if it falls below the
 * configured threshold.
 *
 * Works with cargo tarpaulin's default text output out of the box. The pattern
 * can be overridden to support other tools.
 *
 * @param name      - Unique step name, used as the key in PipelineContext.results.
 * @param readFrom  - Name of the step whose output contains the coverage report.
 * @param threshold - Minimum acceptable coverage percentage (0-100).
 * @param pattern   - Regex with a capture group for the percentage (default: tarpaulin format).
 */
export function createCoverageGateStep<TEvent = unknown>(
  name: string,
  readFrom: string,
  threshold: number,
  pattern: RegExp = DEFAULT_COVERAGE_PATTERN,
): PipelineStep<TEvent> {
  return {
    name,
    execute: async (ctx: PipelineContext<TEvent>): Promise<Result<StepResult>> => {
      const startedAt = Date.now();
      const priorOutput = ctx.results.get(readFrom)?.output ?? "";
      const match = pattern.exec(priorOutput);

      if (match === null || match[1] === undefined) {
        return {
          ok: false,
          error: new Error(
            `Coverage gate "${name}": could not parse coverage percentage from ` +
              `step "${readFrom}" output using pattern ${pattern.toString()}`,
          ),
        };
      }

      const percentage = Number.parseFloat(match[1]);

      if (percentage < threshold) {
        return {
          ok: false,
          error: new Error(
            `Coverage gate "${name}": ${percentage.toFixed(2)}% is below threshold ${threshold}%`,
          ),
        };
      }

      const durationMs = Date.now() - startedAt;

      return {
        ok: true,
        value: {
          stepName: name,
          output: `Coverage: ${percentage.toFixed(2)}% (threshold: ${threshold}%)`,
          durationMs,
        },
      };
    },
  };
}
