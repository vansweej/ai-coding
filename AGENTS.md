# AI Coding OS - Agent Instructions

## Project Overview

TypeScript monorepo for an AI coding OS that routes requests to LLM models via
named **model profiles** and runs multi-step agent pipelines. Uses **Bun** as
runtime and package manager. LLM calls route through one of five providers
depending on the active profile: **GitHub Copilot** (`copilot/claude-sonnet-5`
for `copilot-default`; `claude-sonnet-4.6` for `hybrid`), local **Ollama**
(`gemma4:26b`, via `local`), native
**Anthropic** (`claude-sonnet-5`, via `anthropic-sonnet`), **Claude on
Amazon Bedrock** (via `bedrock-sonnet`, invoked through an application
inference profile ARN using the AWS SDK credential chain), or **OpenCode
Zen** (via `opencode-free`, an OpenAI-compatible chat/completions endpoint
resolved from the `OPENCODE_ZEN_MODEL` env var). The `hybrid`
profile mixes Copilot and Ollama per role.

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
      model-profiles.ts    - ModelRole, ModelProfile, copilot-default, hybrid, anthropic-sonnet, bedrock-sonnet, and opencode-free profiles
      pipeline-registry.ts - Single source of truth for pipeline metadata
    core/
      model-router/        - action → ModelRole; role + profile → model ID
      mode-router/         - source → AIMode ("editor" | "agentic")
      orchestrator/        - Single LLM call lifecycle; CopilotDispatcher (sends the durable GITHUB_COPILOT_TOKEN OAuth token DIRECTLY as the chat Bearer credential — NO copilot_internal/v2/token exchange, which is WAF-blocked for opencode-minted tokens — with an honest User-Agent and X-GitHub-Api-Version: 2026-06-01 mirroring opencode), OllamaDispatcher, AnthropicDispatcher, OpenCodeZenDispatcher; orchestratePatch() (structured-patch facade, see below); patch-contract.ts, patch-capability.ts
      pipeline/
        steps/             - OrchestratorStep, SkillResolverStep, VerifiedImplementStep, structured-implement.ts (tryStructuredPhase: whole-phase structured patch attempt with transactional apply/rollback, tried ahead of the aider-text retry loop)
        definitions/       - dev-cycle language configs (interactive), PLAN_CONFIG_FACTORIES
                             toolchain registry for plan-cycle (rust, typescript, python, cpp,
                             haskell, julia, nix, shell), scaffold-*
        routing/           - route.ts: auto-routes each touched file to a toolchain based on the
                             workspace's devShell palette; unmatched/unavailable files are edit-only
        progress.ts        - ProgressEvent model + pure formatProgressEvent (--verbose feed)
        git-clean-args.ts  - buildGitCleanArgs: constructs the git-clean argv, always excluding
                             plans/ and optionally an explicit --plan path; single source of
                             truth for the plan-file exclusion contract used by restoreWorkingTree
    cli/
      parse-args.ts        - CLI args (--profile, --input, --plan, --verbose/-v flags)
      load-config.ts       - Builds OrchestratorConfig with selected profile
      select-pipeline.ts   - Instantiates pipeline by name
    shared/
      event-types.ts       - Shared type definitions (AIRequestEvent, AIAction, etc.); also the
                             HARD RULE zero-import root of the dependency graph (@ai-coding/shared
                             alias target) — hosts PatchOp, PATCH_TOOL_NAME, PATCH_OPS_JSON_SCHEMA,
                             and the optional ModelDispatcher.dispatchPatch? channel. This file must
                             NEVER import from patch-contract.ts or parse-patch.ts (would create a
                             cycle); patch-contract.ts depends on both, never the reverse.
  opencode/
    mappings/              - OpenCode provider/model configs (symlinked by Home Manager)
  docs/                    - Project documentation
  scripts/
    probe-copilot-toolcalls.ts - One-shot diagnostic (v8-ignore excluded from coverage) probing
                             whether a backend's proxy honors forced tool_calls for the structured
                             patch schema. See docs/adr/ for probe results per backend.
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
   - `docs/architecture.md` — for structural or pipeline changes (includes working-tree
     restore behavior and the plan-file exclusion contract: `plans/` and the active
     `--plan` path are excluded from `git clean` during a phase abort)
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

## Strict Mode, Degraded Exit Code, and `test` Assertion

### `--strict` flag
Pass `--strict` (or set `strict: true` in `loadConfig`) to treat structured-patch
decline reasons `dispatch-error` and `conversion-failed` as hard failures instead of
falling back to the aider-text loop. Useful in CI to surface wiring problems early.

### `DEGRADED` exit code (4)
When a plan-cycle run completes but accumulated non-fatal degradations (e.g.
structured-patch fell back to the text loop), the CLI exits with code **4**
rather than 0. All phases committed successfully; the degradation list is
printed to stdout as `WARN:` lines.

### `Assert: test <path>` assertion verb
A phase directive that runs a single test file and fails the phase if the test
does not pass:
```
Assert: test <relative-or-absolute-path-to-test-file>
```
The file is executed with `bun test <path>` inside a `NixShellStep` (respecting
the workspace's devShell). A missing file, a syntax error, or any failing test
assertion causes the phase to fail before commit. Useful for encoding a
machine-checked "this specific test must be green" invariant alongside the
other structural assertion verbs.

## Models and Routing

See `docs/architecture.md` for the action → role → model routing table.
