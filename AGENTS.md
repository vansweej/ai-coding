# AI Coding OS - Agent Instructions

## Project Overview

TypeScript monorepo for an AI coding OS that routes requests to LLM models via
named **model profiles** and runs multi-step agent pipelines. Uses **Bun** as
runtime and package manager. All LLM calls go through **GitHub Copilot**
(`claude-sonnet-4.6`) via the `copilot-default` profile.

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
      model-profiles.ts    - ModelRole, ModelProfile, copilot-default profile
      pipeline-registry.ts - Single source of truth for pipeline metadata
    core/
      model-router/        - action → ModelRole; role + profile → model ID
      mode-router/         - source → AIMode ("editor" | "agentic")
      orchestrator/        - Single LLM call lifecycle; CopilotDispatcher
      pipeline/
        steps/             - OrchestratorStep, FileWriterStep, NixShellStep
        definitions/       - dev-cycle, rust-dev-cycle, cmake-dev-cycle, scaffold-*
    cli/
      parse-args.ts        - CLI args (--profile, --input flags)
      load-config.ts       - Builds OrchestratorConfig with copilot-default profile
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
6. **Keep the Home Manager repo in sync** — when adding or modifying any
   **agent** (`.md` in `agents/`), **skill** (`SKILL.md` in `skill/`), or
   **command** (`.md` in `commands/`), also update the source file in
   `~/Projects/home-manager/opencode/` and, if the file is new, add a
   `.source` entry in `home.nix`. After changes, delete any conflicting plain
   files under `~/.config/opencode/` and run:
   ```bash
   home-manager switch --flake ~/Projects/home-manager#<machine>
   ```
   (replace `<machine>` with your profile name, e.g. `M5`, `oryp6`, `M1`)
7. **Update documentation with every change** — when adding, modifying, or
   removing any feature, agent, pipeline, skill, or configuration in this
   repository, update the corresponding documentation in the same commit:
   - `docs/agents.md` — for agent changes (tables, descriptions, workflows,
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
   | Agents (tables, descriptions, workflows) | `docs/agents.md` |
   | Architecture or pipeline structure | `docs/architecture.md` |
   | Setup / daily workflow | `docs/ai-coding-os-setup.md` |
   | Codebase indexer | `docs/codebase-indexer.md` |
   | User-facing pipelines / configuration | `README.md` |
   | Conventions, rules, directory structure | `AGENTS.md` |

---

## Code Style & Testing

Conventions for TypeScript formatting (Biome), naming, imports, type rules,
error handling, and test structure are in the `typescript` skill — loaded
automatically via `skill-retrieval` for any workspace with a `package.json`.

---

## Git Workflow

- Create feature branches from `main` (e.g., `feat/mode-router`)
- Use [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
- Keep commits atomic and focused on a single change
- Imperative mood: "add model router" not "added model router"

---

## Models and Routing

This project routes AI requests to different models via the role/profile system:

| Action  | Role          | Model               | Where        |
|---------|---------------|---------------------|--------------|
| plan    | `planner`     | `claude-sonnet-4.6` | Copilot API  |
| debug   | `debugger`    | `claude-sonnet-4.6` | Copilot API  |
| edit    | `implementer` | `claude-sonnet-4.6` | Copilot API  |
| explore | `explorer`    | `claude-sonnet-4.6` | Copilot API  |
| *other* | `default`     | `claude-sonnet-4.6` | Copilot API  |

All roles use `github-copilot/claude-sonnet-4.6` in the `copilot-default` profile.

### OpenCode agent model

OpenCode agents (defined globally in `~/.config/opencode/agents/` via Home Manager)
use either **`github-copilot/claude-opus-4.6`** (plan, spar, teach, brainstorm) or
**`github-copilot/claude-sonnet-4.6`** (build, local, explore, and all subagents)
via the GitHub Copilot provider.

The model-router (`ai-system/core/model-router/`) maps `AIAction` → `ModelRole`
via `actionToRole()`, then resolves the model ID via `resolveModelForRole(role, profile)`.
The active profile is set in `OrchestratorConfig.profile` and defaults to `copilot-default`.
