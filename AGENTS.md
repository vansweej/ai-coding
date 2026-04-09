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

# Run a single test file
bun test ai-system/core/model-router/select-model.test.ts

# Run tests matching a name pattern
bun test --grep "selectModel"

# Run with coverage
bun test --coverage

# Watch mode
bun test --watch
```

Target **90% code coverage**. Exclude untestable code from coverage with
`/* v8 ignore start */` / `/* v8 ignore stop */` comments.

---

## Code Style

### Formatting (enforced by Biome)

- 2-space indentation
- Semicolons: **always**
- Double quotes for strings
- Trailing commas in multi-line constructs
- Max line width: 100 characters

### Naming Conventions

| Element              | Convention     | Example                          |
|----------------------|----------------|----------------------------------|
| Files and directories| `kebab-case`   | `model-router/select-model.ts`   |
| Functions and vars   | `camelCase`    | `selectModel`, `eventId`         |
| Types and interfaces | `PascalCase`   | `AIRequestEvent`, `AIAction`     |
| Type aliases         | `PascalCase`   | `AIModeHint`                     |
| Constants            | `UPPER_SNAKE`  | `MAX_RETRIES`, `DEFAULT_MODEL`   |
| Enums                | `PascalCase`   | `ModelTier.Local`                |
| Test files           | `*.test.ts`    | `select-model.test.ts`           |

### Imports

Order imports in this sequence, separated by blank lines:

1. External packages (`import { z } from "zod";`)
2. Workspace aliases (`import { ... } from "@ai-coding/shared";`)
3. Relative imports (`import { selectModel } from "./select-model";`)

Use **named exports** exclusively. Do not use default exports.

```typescript
// Good
export function selectModel(event: AIRequestEvent, mode: AIModeHint): string { ... }

// Bad - no default exports
export default function selectModel(...) { ... }
```

### TypeScript

- Enable `strict: true` in `tsconfig.json`
- Always annotate function parameters and return types
- Use `type` for unions and aliases; use `interface` for object shapes
- Prefer `const` over `let`; never use `var`
- Use `readonly` for properties that must not be reassigned
- Avoid `any`; use `unknown` when the type is truly unknown
- Avoid type assertions (`as`); prefer type guards or narrowing

```typescript
// Good - fully typed
export function selectModel(event: AIRequestEvent, mode: AIModeHint): string {
  if (mode === "agentic") {
    if (event.action === "plan") return "claude-sonnet";
    if (event.action === "debug") return "deepseek-coder-v2";
    return "qwen2.5-coder:7b";
  }
  return "qwen2.5-coder:7b";
}
```

### Error Handling

- Define typed error classes or discriminated unions for error states
- Never swallow errors silently
- Use early-return guard clauses to reduce nesting
- For functions that can fail predictably, prefer a `Result` pattern:

```typescript
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
```

### Comments

- Use `//` for inline explanations of *why*, not *what*
- Use JSDoc (`/** ... */`) on all exported functions and types
- Do not leave commented-out code in the codebase

---

## Testing Conventions

- Co-locate test files next to source: `select-model.test.ts` beside `select-model.ts`
- Use Bun's built-in test runner (`bun:test`)
- Structure tests with `describe` / `it` blocks
- One logical assertion per `it` block when practical
- Name tests as behavior: `"returns local model in editor mode"`

```typescript
import { describe, it, expect } from "bun:test";
import { selectModel } from "./select-model";

describe("selectModel", () => {
  it("returns claude-sonnet for plan action in agentic mode", () => {
    const event = { action: "plan" } as AIRequestEvent;
    expect(selectModel(event, "agentic")).toBe("claude-sonnet");
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

| Action   | Mode     | Model                | Where        |
|----------|----------|----------------------|--------------|
| plan     | agentic  | `claude-sonnet`      | Cloud API    |
| debug    | agentic  | `deepseek-coder-v2`  | Local/Ollama |
| *other*  | agentic  | `qwen2.5-coder:7b`   | Local/Ollama |
| *any*    | editor   | `qwen2.5-coder:7b`   | Local/Ollama |

Local models are served via **Ollama** at `http://localhost:11434`.
