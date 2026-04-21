# AI Coding OS - Agent Instructions

## Project Overview

TypeScript monorepo for an AI coding OS that routes requests to different LLM
models based on task type and operating mode. Uses **Bun** as runtime and
package manager. Local models served via **Ollama**.

### Directory Structure

```
ai-coding/
  ai-system/
    core/
      model-router/    - Selects LLM model based on action + mode
      mode-router/     - Determines operating mode (editor vs agentic) [planned]
      orchestrator/    - Coordinates the full request lifecycle [planned]
    shared/
      event-types.ts   - Shared type definitions (AIRequestEvent, AIAction, etc.)
  opencode/
    mappings/          - OpenCode model/provider mapping configs [planned]
    profiles/          - OpenCode agent profiles [planned]
  docs/                - Project documentation
```

### Bootstrap Status

The following config files do not exist yet and must be created before the
commands below will work:

- `package.json` — run `bun init` and add the scripts listed below
- `tsconfig.json` — must have `strict: true` and `@ai-coding/shared` path alias
- `biome.json` — must enforce the style rules in this file

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
// ... untestable code (e.g., UI callbacks, Ollama connectivity checks) ...
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
export function selectModel(event: AIRequestEvent, mode: AIModeHint): string {
  if (mode === "agentic") {
    if (event.action === "plan") return "claude-sonnet";
    if (event.action === "debug") return "deepseek-coder-v2";
    return "qwen3:8b";
  }
  return "qwen3:8b";
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

import { AIRequestEvent } from "@ai-coding/shared";

import { selectModel } from "./select-model";

describe("selectModel", () => {
  it("returns claude-sonnet for plan action in agentic mode", () => {
    const event = { action: "plan" } as AIRequestEvent;
    expect(selectModel(event, "agentic")).toBe("claude-sonnet");
  });

  it("returns qwen3:8b in editor mode regardless of action", () => {
    const event = { action: "plan" } as AIRequestEvent;
    expect(selectModel(event, "editor")).toBe("qwen3:8b");
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

This project routes AI requests to different models:

| Action  | Mode    | Model               | Where        |
|---------|---------|---------------------|--------------|
| plan    | agentic | `claude-sonnet`     | Cloud API    |
| debug   | agentic | `deepseek-coder-v2` | Local/Ollama |
| *other* | agentic | `qwen3:8b`  | Local/Ollama |
| *any*   | editor  | `qwen3:8b`  | Local/Ollama |

Local models are served via **Ollama** at `http://localhost:11434`.
