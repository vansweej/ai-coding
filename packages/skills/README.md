# @ai-coding/skills

Shared skill retrieval abstraction for the AI Coding OS. Resolves the right set
of skill files for a given AI action and workspace context, merges them into a
single string, and injects the result into LLM system prompts.

## Quick Start

```typescript
import { FileBackend, mergeSkills, resolveSkill } from "@ai-coding/skills";

const backend = new FileBackend(); // reads from ~/.config/opencode/skill/

const skills = await resolveSkill(
  { action: "edit", workspace: "/my/rust/project" },
  backend,
);
// → [{ name: "programmer", content: "..." }, { name: "rust", content: "..." }]

const systemPrompt = mergeSkills(skills);
// → "## Skill: programmer\n\n...\n\n---\n\n## Skill: rust\n\n..."
```

## In a Pipeline

```typescript
import { createSkillResolverStep, FileBackend } from "@ai-coding/skills";
import { createDevCyclePipeline } from "ai-system/core/pipeline/definitions/dev-cycle";

const steps = createDevCyclePipeline(config, workspace, new FileBackend());
// → [resolve-skills, plan, implement, write-files, test]
```

## How Resolution Works

Resolution uses two orthogonal dimensions:

1. **Action → "what to do" skills** (general method)
2. **Workspace type → "how to do it here" skills** (domain specialization)

```
edit + Rust project → ["programmer", "rust"]
debug + C++ project → ["debugger", "cpp"]
plan + unknown      → ["architect"]
```

Action skills always appear before workspace skills. Domain skills act as a
specialization layer: the LLM reads general instructions first, then
language-specific constraints.

## Pluggable Backend

Consumers are blind to the backend implementation:

```typescript
interface SkillBackend {
  resolve(context: RetrievalContext): Promise<readonly ResolvedSkill[]>;
}
```

- **Phase 1 (current):** `FileBackend` — reads full `SKILL.md` files from disk
- **Phase 2 (planned):** `VectorBackend` — chunks skills at `##` headings, embeds
  via Ollama, queries LanceDB by semantic similarity, returns top-k chunks

Swapping backends requires no changes to consumers.

## Module Structure

```
src/
  index.ts                  Barrel exports
  skill-types.ts            RetrievalContext, ResolvedSkill, SkillBackend, WorkspaceType
  resolve-skill.ts          resolveSkill() — stable public API
  merge-skills.ts           mergeSkills() — concatenate for system prompt injection
  skill-map.ts              ACTION_SKILLS, WORKSPACE_SKILLS, resolveSkillNames()
  detect-workspace-type.ts  Filesystem probe → WorkspaceType
  backends/
    file-backend.ts         Phase 1: reads SKILL.md files from disk
```

## Full Documentation

See [docs/skills.md](../../docs/skills.md) for architecture diagrams, full API
reference, routing tables, and Phase 2 evolution plan.
