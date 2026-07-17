# AI Coding OS - Agent Instructions

## Project Overview

TypeScript monorepo for an AI coding OS that routes requests to LLM models via
named **model profiles** and runs multi-step agent pipelines. Uses **Bun** as
runtime and package manager. LLM calls route through one of three providers
depending on the active profile: **GitHub Copilot** (`claude-sonnet-4.6`, via
`copilot-default`), local **Ollama** (`gemma4:26b`, via `local`), or native
**Anthropic** (`claude-sonnet-5`, via `anthropic-sonnet`). The `hybrid` profile
mixes Copilot and Ollama per role.

### Directory Structure

```
ai-coding/
  packages/
    embeddings/            - Shared embedding abstraction (@ai-coding/embeddings)
                             Embedder, EmbeddingResult, OllamaEmbedder, isOllamaReachable
    pipeline/              - Generic pipeline infrastructure (@ai-coding/pipeline)
                             runPipeline, PipelineStep, ShellStep, NixShellStep, CoverageGateStep
    skills/                - Skill retrieval system (@ai-coding/skills)
                             resolveSkill, mergeSkills, FileBackend, VectorBackend, LanceStore, chunkSkill
    codebase/              - Codebase RAG indexer (@ai-coding/codebase)
                             CodebaseBackend, indexCodebase, CodebaseStore, ParserPool, chunkFile
  ai-system/
    config/
      model-profiles.ts    - ModelRole, ModelProfile, copilot-default, hybrid, and anthropic-sonnet profiles
      pipeline-registry.ts - Single source of truth for pipeline metadata
    core/
      model-router/        - action → ModelRole; role + profile → model ID
      mode-router/         - source → AIMode ("editor" | "agentic")
      orchestrator/        - Single LLM call lifecycle; CopilotDispatcher, OllamaDispatcher, AnthropicDispatcher
      pipeline/
        steps/             - OrchestratorStep, SkillResolverStep, VerifiedImplementStep
        definitions/       - unified dev-cycle language configs, scaffold-*
    cli/
      parse-args.ts        - CLI args (--profile, --input, --plan, --language flags)
      load-config.ts       - Builds OrchestratorConfig with selected profile
      select-pipeline.ts   - Instantiates pipeline by name
    shared/
      event-types.ts       - Shared type definitions (AIRequestEvent, AIAction, etc.)
  opencode/
    mappings/              - OpenCode provider/model configs (symlinked by Home Manager)
  docs/                    - Project documentation
```

---

## Build Commands

All commands run from the repository root (`ai-coding/`).

```bash
# Install dependencies
bun install

# Type-check (no emit)
bun run typecheck           # runs: bunx tsc --noEmit

# Build
bun run build

# Lint (Biome)
bun run lint                # runs: bunx biome check .
bun run lint:fix            # runs: bunx biome check --write .

# Format (Biome)
bun run format              # runs: bunx biome format .
bun run format:fix          # runs: bunx biome format --write .

# Lint + format in one pass
bunx biome check --write .
```

### Testing

```bash
# Run all tests
bun test

# Run a single test file (path relative to repo root)
bun test ai-system/core/model-router/select-model.test.ts

# Run tests matching a name pattern
bun test --grep "selectModel"

# Run with coverage
bun test --coverage

# Watch mode
bun test --watch
```

Target **90% code coverage**. Exclude untestable code with:

```typescript
/* v8 ignore start */
// ... untestable code (e.g., UI callbacks, network startup paths) ...
/* v8 ignore stop */
```

---

## Agent Workflow Rules

1. **Always work on a feature branch** created from `main` — never commit
   directly to `main`. Branch names: `feat/...`, `fix/...`, `refactor/...`, etc.
2. **Before opening a PR**, run in order:
   - `bun run typecheck`
   - `bunx biome check --write .`
   - `bun test --coverage`
3. All three must pass with no errors and coverage must be ≥ 90%.
4. **Never leave `TODO` comments** — either implement the thing or open a
   tracked issue.
5. **Never leave commented-out code** in the codebase.
6. **Keep the Home Manager repo in sync** — when modifying agents, skills, or
   commands, update the source in `~/Projects/home-manager/opencode/` and run
   `home-manager switch --flake ~/Projects/home-manager#<machine>`.
7. **Update documentation with every change** — when adding, modifying, or
   removing any feature, agent, pipeline, skill, or configuration in this
   repository, update the corresponding documentation in the same commit:
   - `docs/agent-reference.md` — for agent changes (tables, descriptions, workflows,
      file listings)
   - `docs/architecture.md` — for structural or pipeline changes
   - `docs/ai-coding-os-setup.md` — for setup-facing changes (agent tables,
     daily workflow steps)
   - `README.md` — for user-facing pipeline or configuration changes
   - `AGENTS.md` — for changes to conventions, rules, or directory structure

   Documentation must never lag behind the code. A PR that adds a feature
   without updating docs is incomplete and must not be merged.

   The canonical reference for each area:

   | Area | Doc file |
   |------|----------|
   | Agents (tables, descriptions, workflows) | `docs/agent-reference.md` |
   | Architecture or pipeline structure | `docs/architecture.md` |
   | Setup / daily workflow | `docs/ai-coding-os-setup.md` |
   | Codebase indexer | `docs/codebase-indexer.md` |
   | User-facing pipelines / configuration | `README.md` |
   | Conventions, rules, directory structure | `AGENTS.md` |

---

## OpenCode Permissions

Defaults in `opencode.json`: `edit: ask`, `write: ask`, `bash: deny` (except read-only git).
Named agents override via frontmatter `permission` block. See `docs/agent-reference.md → Permission Model`.

## Code Style & Testing

Conventions for TypeScript formatting (Biome), naming, imports, type rules,
error handling, and test structure are in the `typescript` skill — loaded
automatically via `skill-retrieval` for any workspace with a `package.json`.

---

## Git Workflow

Feature branches from `main` (`feat/…`, `fix/…`). [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`. Imperative mood, atomic commits.

---

## Models and Routing

See `docs/architecture.md` for the action → role → model routing table.
