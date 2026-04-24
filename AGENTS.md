# AI Coding OS - Agent Instructions

## Project Overview

TypeScript monorepo for an AI coding OS that routes requests to LLM models via
named **model profiles** and runs multi-step agent pipelines. Uses **Bun** as
runtime and package manager. All LLM calls go through **GitHub Copilot**
(`claude-sonnet-4.6`) via the `copilot-default` profile.

### Directory Structure

```
ai-coding/
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
  .opencode/
    agents/                - Project-local subagents (planner, debugger, reviewer, tester)
    commands/              - Pipeline slash commands
    tools/                 - Custom OpenCode tools
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
   home-manager switch --flake ~/Projects/home-manager#oryp6
   ```
   to activate. Verify the target file is a Nix store symlink afterwards.
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

---

## Code Style

### Formatting (enforced by Biome)

- 2-space indentation
- Semicolons: **always**
- Double quotes for strings
- Trailing commas in multi-line constructs
- Max line width: 100 characters

### Naming Conventions

| Element               | Convention      | Example                         |
|-----------------------|-----------------|---------------------------------|
| Files and directories | `kebab-case`    | `model-router/select-model.ts`  |
| Functions and vars    | `camelCase`     | `selectModel`, `eventId`        |
| Types and interfaces  | `PascalCase`    | `AIRequestEvent`, `AIAction`    |
| Type aliases          | `PascalCase`    | `AIModeHint`                    |
| Constants             | `UPPER_SNAKE`   | `MAX_RETRIES`, `DEFAULT_MODEL`  |
| Enums                 | `PascalCase`    | `ModelTier.Local`               |
| Test files            | `*.test.ts`     | `select-model.test.ts`          |

### Imports

Order imports in this sequence, separated by blank lines:

1. External packages — `import { z } from "zod";`
2. Workspace aliases — `import { ... } from "@ai-coding/shared";`
3. Relative imports — `import { selectModel } from "./select-model";`

Use **named exports** exclusively. Default exports are forbidden.

```typescript
// Good
export function selectModel(event: AIRequestEvent, mode: AIModeHint): string { ... }

// Bad — never use default exports
export default function selectModel(...) { ... }
```

### TypeScript

- Enable `strict: true` in `tsconfig.json`
- Always annotate function parameters and return types explicitly
- Use `type` for unions and aliases; use `interface` for object shapes
- Prefer `const` over `let`; never use `var`
- Use `readonly` for properties that must not be reassigned after construction
- Avoid `any`; use `unknown` when the type is truly unknown
- Avoid type assertions (`as`); prefer type guards or narrowing

```typescript
// Good — fully typed, named export, early returns
export function resolveModelForRole(role: ModelRole, profile: ModelProfile): string {
  return profile.roles[role];
}
```

### Error Handling

- Define typed error classes or discriminated unions for error states
- Never swallow errors silently
- Use early-return guard clauses to reduce nesting
- For functions that can fail predictably, prefer the `Result` pattern:

```typescript
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

function parseEvent(raw: unknown): Result<AIRequestEvent> {
  if (!isValidEvent(raw)) {
    return { ok: false, error: new Error("Invalid event shape") };
  }
  return { ok: true, value: raw };
}
```

### Comments

- Use `//` for inline explanations of *why*, not *what*
- Use JSDoc (`/** ... */`) on all exported functions and types
- Do not leave commented-out code in the codebase

---

## Testing Conventions

- Co-locate test files next to source: `select-model.test.ts` beside `select-model.ts`
- Use Bun's built-in test runner (`bun:test`) — not Jest, Vitest, or any other
- Structure tests with `describe` / `it` blocks
- One logical assertion per `it` block when practical
- Name tests as observable behavior: `"returns local model in editor mode"`

```typescript
import { describe, expect, it } from "bun:test";

import { COPILOT_DEFAULT_PROFILE } from "@ai-system/config/model-profiles";

import { resolveModelForRole } from "./model-profiles";

describe("resolveModelForRole", () => {
  it("returns claude-sonnet-4.6 for planner in copilot-default", () => {
    expect(resolveModelForRole("planner", COPILOT_DEFAULT_PROFILE)).toBe("claude-sonnet-4.6");
  });

  it("returns claude-sonnet-4.6 for implementer in copilot-default", () => {
    expect(resolveModelForRole("implementer", COPILOT_DEFAULT_PROFILE)).toBe("claude-sonnet-4.6");
  });
});
```

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

OpenCode agents (defined in `.opencode/agents/` and `~/.config/opencode/agents/`)
use either **`github-copilot/claude-opus-4.6`** (plan, spar, teach) or
**`github-copilot/claude-sonnet-4.6`** (build, local, explore, and all subagents)
via the GitHub Copilot provider.

The model-router (`ai-system/core/model-router/`) maps `AIAction` → `ModelRole`
via `actionToRole()`, then resolves the model ID via `resolveModelForRole(role, profile)`.
The active profile is set in `OrchestratorConfig.profile` and defaults to `copilot-default`.
