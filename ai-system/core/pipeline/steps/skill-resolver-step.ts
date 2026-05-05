import type { PipelineStep, Result, StepResult } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";
import { mergeSkills, resolveSkill } from "@ai-coding/skills";
import type { SkillBackend } from "@ai-coding/skills";

/**
 * Creates a pipeline step that resolves relevant skills for the current request
 * and stores the merged skill content in the pipeline context.
 *
 * The step derives the `RetrievalContext` from the pipeline event:
 *   - `action` → from `ctx.event.action`
 *   - `workspace` → from `ctx.event.payload.workspace`
 *
 * The merged skill content is stored as `StepResult.output` under the given step
 * name. Downstream steps (typically `OrchestratorStep`) read it via:
 *   ```typescript
 *   ctx.results.get("resolve-skills")?.output
 *   ```
 * and prepend it to the system prompt passed in `LLMOptions.system`.
 *
 * When no skills resolve (e.g. `action: "chat"` with no workspace), the step
 * succeeds with an empty output string — downstream steps must handle this case.
 *
 * @param name    - Unique step name used as the key in `PipelineContext.results`.
 * @param backend - The skill backend to use for resolution (typically `FileBackend`).
 */
export function createSkillResolverStep(
  name: string,
  backend: SkillBackend,
): PipelineStep<AIRequestEvent> {
  return {
    name,
    execute: async (ctx): Promise<Result<StepResult>> => {
      const startedAt = Date.now();

      const skills = await resolveSkill(
        {
          action: ctx.event.action,
          workspace: ctx.event.payload.workspace,
        },
        backend,
      );

      const output = mergeSkills(skills);

      return {
        ok: true,
        value: {
          stepName: name,
          output,
          durationMs: Date.now() - startedAt,
        },
      };
    },
  };
}
