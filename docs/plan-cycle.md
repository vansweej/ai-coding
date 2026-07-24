# Plan Cycle (`plan-cycle` / `rust-plan-cycle`) — Comprehensive Guide

`plan-cycle` is an unattended, multi-phase, **multi-language** implementation engine designed
for CI/CD workflows and autonomous agent execution. It combines structured planning, automatic
repair, memory tracking, and resumable failures into a single cohesive system that works across
8 languages: Rust, TypeScript, Python, C++, Haskell, Julia, Nix, and Shell.

`rust-plan-cycle` is a legacy-compatible **alias** for `plan-cycle --language rust` — the original
pipeline name from before multi-language support was added. Both names invoke the same pipeline
implementation; the alias only changes the default language.

## Table of Contents

1. [Overview](#overview)
2. [Language Support](#language-support)
3. [Architecture](#architecture)
4. [Plan File Format](#plan-file-format)
5. [Usage](#usage)
6. [Resume Workflow](#resume-workflow)
7. [Memory Client Integration](#memory-client-integration)
8. [Exit Codes](#exit-codes)
9. [Troubleshooting](#troubleshooting)
10. [Examples](#examples)

---

## Overview

### What is plan-cycle?

`plan-cycle` is a pipeline that:

1. **Parses a structured plan file** into phases and steps
2. **Resolves the language** for each phase (per-phase `Language:` directive, or the run's
   default language)
3. **Executes each phase sequentially**, implementing all steps before committing
4. **Verifies each phase** with the resolved language's toolchain (format, lint, typecheck,
   test, and — for Rust — coverage)
5. **Retries locally** when verification fails, with diagnostics
6. **Escalates to the fixer role** if local retries are exhausted
7. **Commits each phase** with a `Phase: N` trailer for resume tracking
8. **Tracks progress in memory** (Cerebrum two-tier memory system)
9. **Resumes from the last completed phase** if interrupted

### Key Differences from the legacy `dev-cycle`

| Feature | `dev-cycle` (deprecated) | `plan-cycle` |
|---------|--------------------------|--------------|
| Execution | Interactive (human-in-the-loop) | Unattended (fully autonomous) |
| Repair | Local retries only | Local retries + fixer-role escalation |
| Memory | None | Two-tier (Synapse + Cortex) |
| Resume | Manual (git-based) | Automatic (git + memory) |
| Language | Single, fixed per pipeline instance | Per-phase, via `Language:` directive |
| Patch format | Fenced code blocks | Aider-style SEARCH/REPLACE patches |
| Branch | Any branch | Feature branch only |

---

## Language Support

`plan-cycle` supports 8 languages via a registry of `PlanConfigFactory` functions
(`PLAN_CONFIG_FACTORIES` in `ai-system/core/pipeline/definitions/language-configs.ts`). Each
factory builds a `DevCycleLanguageConfig` from the phase's `Coverage:` directive and the current
git diff, producing a language-specific implementation prompt and toolchain.

| Language | `--language` value | Toolchain steps | Coverage gate | `baselineCheck` |
|----------|--------------------|-----------------|:---:|:---:|
| Rust | `rust` | `cargo fmt` → `cargo check` → `cargo clippy -D warnings` → `cargo test` → `cargo tarpaulin` → coverage gate | ✅ fatal | — |
| TypeScript | `typescript` | `bun run typecheck` → `bunx biome check --write .` → `bun test` (300s) | — | — |
| Python | `python` | `ruff format --check` → `ruff check` → `mypy .` (warning-only) → `pytest -q` (300s) | — | — |
| C++ | `cpp` | `cmake -S . -B build` (120s) → `cmake --build build` (300s) → `ctest --test-dir build` (300s) | — | — |
| Haskell | `haskell` | `cabal build` (600s, doubles as typecheck) → `hlint .` → `cabal test` (600s) | — | — |
| Julia | `julia` | `julia --project -e 'using Pkg; Pkg.test()'` (900s, weak — no separate format/lint) | — | — |
| Nix | `nix` | `nixpkgs-fmt --check .` → `nix flake check` (900s) | — | ✅ |
| Shell | `shell` | `shfmt -d .` → guarded `shellcheck` (900s wrapper; empty-guarded via `git ls-files "*.sh"`) | — | ✅ |

Only Rust currently gates on coverage; the other 7 languages accept the phase's `Coverage:`
directive for `PlanConfigFactory` signature compatibility but do not act on it yet.

**`baselineCheck`** — Nix and Shell run their toolchain once on the *untouched* tree before any
implementation attempt for a phase, because `nix flake check` and repo-wide `shellcheck` cannot
be scoped to a diff. A pre-existing failure here is treated as an **environment error** (exit
code 3), not a retryable phase failure — see [`docs/plan-cycle-languages.md`](plan-cycle-languages.md)
for the full rationale and required flake dev-shell tooling per language.

### Default language resolution

```
phase.language (per-phase "Language:" directive)
  ?? defaultLanguage (--language flag, or "rust" if pipeline name is the rust-plan-cycle alias)
  ?? "typescript" (fallback when neither is set)
```

The `rust-plan-cycle` alias **always** forces `rust` as the default, regardless of `--language` —
this preserves the original single-language pipeline's behavior for existing callers. An explicit
per-phase `Language:` directive always wins over the run's default, in either invocation.

Requesting a language with no registered factory returns a clear error
(`Phase N uses unregistered language "..."`) rather than silently falling back to the wrong
toolchain.

See [`docs/plan-cycle-languages.md`](plan-cycle-languages.md) for the full per-language reference,
including required Nix flake dev-shell tooling.

---

## Architecture

### Pipeline Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Parse Plan File                                          │
│    - Extract feature name, phases, steps                    │
│    - Parse per-phase Language: and Coverage: directives      │
│    - Validate plan structure                                 │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Detect Resume State (if needed)                           │
│    - Check git log for Phase: N trailers                    │
│    - Reset to last completed phase if dirty                 │
│    - Skip completed phases                                  │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. For Each Phase:                                           │
│    a. Resolve language (phase directive ?? run default)     │
│    b. Look up the PlanConfigFactory; error if unregistered   │
│    c. Run baseline check if the resolved config sets it      │
│    d. Store phase context in memory (salience 0.8)           │
│    e. Implement all steps                                    │
│    f. Store responses in memory (salience 0.6)                │
│    g. Verify with the resolved language's toolchain           │
│    h. Retry locally if verification fails                    │
│    i. Escalate to the fixer role if retries exhausted         │
│    j. Commit phase with Phase: N trailer                     │
│    k. Store completion in memory (salience 0.9)               │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Exit with Status Code                                    │
│    - 0: all phases passed                                    │
│    - 2: phase exhausted repair budget (resumable)            │
│    - 3: input/environment error (incl. baseline check failure)│
└─────────────────────────────────────────────────────────────┘
```

### Retry Loop

When verification fails:

1. **Local retries** (up to `--max-retries`, default 3):
   - Run the implementer role again with verification diagnostics
   - Re-verify with the toolchain
   - If successful, continue to next phase
   - If still failing, proceed to escalation

2. **Fixer escalation** (if local retries exhausted):
   - Route to the `fixer` role (may be a different, more capable model depending on the
     active profile)
   - Provide full context (error, code, diagnostics)
   - Attempt one final fix
   - If successful, continue to next phase
   - If still failing, exit with code 2 (resumable failure)

### Baseline Check (Nix and Shell only)

For languages whose toolchain includes a whole-repo validator that cannot be scoped to a diff
(`nix flake check`, repo-wide `shellcheck`), `plan-cycle` runs that toolchain once on the
untouched tree **before** any implementation attempt for the phase:

```
┌─────────────────────────────────────────────────────────────┐
│ Baseline check (only when languageConfig.baselineCheck)      │
│    Run toolchainSteps() on the untouched tree                │
│    ├── Pass → proceed to implementation as normal             │
│    └── Fail → BaselineCheckError → exit code 3 immediately    │
│               (no implementation attempt, no memory writes,   │
│                no commit)                                     │
└─────────────────────────────────────────────────────────────┘
```

This distinguishes "the repo was already broken" from "the implementation broke it" — the former
is an environment error the operator must fix outside the pipeline (e.g. a stale flake lock), not
something more retries or escalation can solve.

---

## Plan File Format

### Structure

```markdown
# Feature: <feature name>

## Phase N: <phase title>

Commit message: <conventional commit message>
Coverage: skip | N% | (omitted for default 90%, Rust only)
Language: rust | typescript | python | cpp | haskell | julia | nix | shell | (omitted to inherit default)

### Step N: <step title>

<step instruction>
```

### Rules

- **Feature name**: Single line after `# Feature:`
- **Phase number**: Must be sequential (1, 2, 3, …)
- **Phase title**: Short description of the phase
- **Commit message**: Conventional commit format (feat:, fix:, refactor:, etc.)
- **Coverage** (optional): `skip`, an explicit `N%` threshold, or omitted for the default.
  Only consulted by the Rust factory today.
- **Language** (optional): One of the 8 known language names. When omitted, the phase
  inherits the run's default language (see [Default language resolution](#default-language-resolution)).
- **Step number**: Must be sequential within each phase (1, 2, 3, …)
- **Step title**: Short description of the step
- **Step instruction**: Plain text instruction for the LLM (can span multiple lines)

### Example: Polyglot Plan File

A single plan file can mix languages across phases — useful for a feature that touches both
a Rust backend and a TypeScript frontend:

```markdown
# Feature: Add rate limiting

## Phase 1: Rust backend rate limiter

Commit message: feat: add token-bucket rate limiter
Language: rust

### Step 1: Implement rate limiter

Create src/rate_limit.rs with a token-bucket algorithm.

## Phase 2: TypeScript client backoff

Commit message: feat: add client-side backoff on 429
Language: typescript

### Step 1: Add retry-with-backoff helper

Add a retryWithBackoff() helper that respects Retry-After headers.
```

Run this with `bun run pipeline plan-cycle ./my-project --plan ./plans/rate-limit.md` — no
`--language` flag needed, since every phase specifies its own language explicitly.

---

## Usage

### Basic Command

```bash
bun run pipeline plan-cycle <workspace> --plan <file> [options]
bun run pipeline rust-plan-cycle <workspace> --plan <file> [options]  # alias, forces Rust
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--plan <file>` | Path to plan file (required, or use `--input` for a single-step plan) | — |
| `--language <name>` | Default language for phases lacking a `Language:` directive | `typescript` (or `rust` when invoked as `rust-plan-cycle`) |
| `--max-retries <n>` | Max local retries per phase | 3 |
| `--profile <name>` | Model profile (`local`, `copilot-default`, `hybrid`, `anthropic-sonnet`, `bedrock-sonnet`) | `copilot-default` |

### Examples

```bash
# Run a polyglot plan (each phase specifies its own Language: directive)
git checkout -b feat/rate-limiting
bun run pipeline plan-cycle ./my-project --plan ./plans/rate-limit.md

# Run a single-language TypeScript plan
bun run pipeline plan-cycle ./my-ts-project --plan ./plans/feature.md --language typescript

# Run with the legacy rust-plan-cycle alias (forces rust regardless of --language)
bun run pipeline rust-plan-cycle ./my-rust-project --plan ./plans/auth.md

# Run with custom retry count
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md --max-retries 5

# Run with local profile (no cloud dependency)
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md --profile local

# Run on native Anthropic Claude Sonnet (recommended — see the token-cap note below)
ANTHROPIC_API_KEY=sk-ant-... bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md --profile anthropic-sonnet

# Run on Claude Sonnet via Amazon Bedrock (uses AWS SSO / credential chain, not an API key)
aws sso login --profile my-company-profile
export AWS_PROFILE=my-company-profile
export AWS_BEDROCK_INFERENCE_PROFILE_ARN=arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/abc123
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md --profile bedrock-sonnet
```

> **Recommended profile:** `--profile anthropic-sonnet` raises the effective output token cap to
> 8192 (both the Anthropic dispatcher default and the implement/fix LLM call options), which
> avoids truncated multi-file patches on larger phases. See
> [`docs/plan-cycle-languages.md`](plan-cycle-languages.md#token-cap-note) for details.
> `--profile bedrock-sonnet` uses the same 8192 default and is the preferred profile when your
> Claude access is provisioned through Amazon Bedrock rather than a native Anthropic API key.

> **Bedrock notes:** `bedrock-sonnet` authenticates via the AWS SDK's default credential provider
> chain (e.g. `aws sso login` + `AWS_PROFILE`), not an API key, and requires
> `AWS_BEDROCK_INFERENCE_PROFILE_ARN` to be set. The target region is parsed from the ARN. SSO
> session credentials are time-bounded (commonly 1–8 hours); start long unattended runs right
> after a fresh login, since expiry mid-run surfaces as a dispatch error and aborts the run
> (exit code 2, resumable — see [Resume workflow](resume-workflow.md)). Never commit the ARN or
> any AWS profile name to source; both are account-specific and belong in the environment only.

> **Note:** `plan-cycle` parses its plan from the `--plan` file (or a single-step plan built
> from `--input`) rather than generating it via an LLM, so the `planner` role never fires on
> this path. Only the `implementer` role (action `edit`, used for initial implementation and
> local retries) and the `fixer` role (action `fix`, used for escalation attempts) actually
> dispatch LLM calls.

### Branch Requirement

`plan-cycle` (and its `rust-plan-cycle` alias) **must run on a dedicated feature branch**.
Protected branches are rejected:

- ❌ `main`
- ❌ `master`
- ❌ `develop`
- ❌ `development`

Create a feature branch before running:

```bash
git checkout -b feat/my-feature
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md
```

---

## Resume Workflow

### Automatic Resume Detection

If a phase fails and exits with code 2, the pipeline can be resumed:

```bash
# Phase 1 fails, exits with code 2
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md
# Exit code: 2

# Fix the issue (manually or wait for next attempt)
# Then run the same command again
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md
# The pipeline detects Phase: 1 in git log
# Resets to Phase 1 commit
# Skips Phase 1, continues with Phase 2
```

### How Resume Works

1. **Detect last completed phase**: Scan git log for `Phase: N` trailers
2. **Check for dirty state**: If working directory is dirty, reset to last phase commit
3. **Skip completed phases**: Start execution from the next phase
4. **Continue normally**: Implement, verify, and commit remaining phases

### Manual Resume Control

If you need to manually reset to a specific phase:

```bash
# Find the commit with Phase: 1
git log --oneline --grep="Phase: 1"

# Reset to that commit
git reset --hard <commit-hash>

# Run the pipeline again
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md
```

---

## Memory Client Integration

### Two-Tier Memory System

The Cerebrum MCP server provides a two-tier memory system:

- **Synapse (short-term)**: Fast, in-memory storage for current session
- **Cortex (long-term)**: Persistent LanceDB storage across sessions

### What Gets Stored

For each phase:

1. **Phase context** (salience 0.8):
   ```json
   {
     "phaseNumber": 1,
     "title": "Create auth module",
     "commitMessage": "feat: add auth module structure",
     "stepsCount": 2,
     "startedAt": 1783956171540
   }
   ```

2. **Implementation responses** (salience 0.6):
   ```json
   {
     "action": "edit",
     "model": "claude-sonnet-5",
     "mode": "agentic",
     "prompt": "...",
     "response": "...",
     "timestamp": 1783956171550
   }
   ```

3. **Phase completion** (salience 0.9):
   ```json
   {
     "phaseNumber": 1,
     "status": "completed",
     "stepsCompleted": 2,
     "completedAt": 1783956171621
   }
   ```

### Memory Scopes

All memories are stored in the `global` scope (shared across all agents and sessions).
Per-agent scoping (`agent:<id>`) is supported but not yet configured.

### Optional Integration

Memory is **optional**. If the Cerebrum server is unavailable:

- The pipeline continues with git-based resume only
- No error is raised
- Phase context is not stored
- Resume still works via git trailers

---

## Exit Codes

| Code | Meaning | Action |
|------|---------|--------|
| **0** | All phases passed | Feature is complete; merge the branch |
| **2** | Phase exhausted repair budget | Fix the issue and run again to resume |
| **3** | Input/environment error (incl. baseline check failure) | Fix the error and retry |

### Exit Code 0 (Success)

All phases completed successfully. The feature branch is ready to merge:

```bash
git push origin feat/my-feature
# Create a pull request
```

### Exit Code 2 (Resumable Failure)

A phase failed after exhausting local retries and fixer escalation. The pipeline
can be resumed after fixing the issue:

```bash
# Review the error message
# Fix the issue manually (edit code, adjust plan, etc.)
# Run the pipeline again
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md
# Exit code: 0 (if successful) or 2 (if another phase fails)
```

### Exit Code 3 (Environment Error)

An input or environment error occurred. Examples:

- Bad plan file format
- Running on a protected branch (main, master, develop)
- Missing toolchain for the resolved language
- Invalid workspace path
- Unknown `--language` value
- A phase's resolved language has no registered `PlanConfigFactory`
- **A baseline check failed** (Nix `nix flake check` or Shell `shellcheck` was already
  red on the untouched tree, before any implementation attempt)

Fix the error and retry:

```bash
# Example: wrong branch
git checkout -b feat/my-feature
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md
```

---

## Troubleshooting

### "Error: plan-cycle must run on a dedicated feature branch"

**Cause**: You are on a protected branch (main, master, develop, development).

**Fix**: Create a feature branch:

```bash
git checkout -b feat/my-feature
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md
```

### "Phase N uses unregistered language"

**Cause**: The resolved language (per-phase `Language:` directive, `--language` flag, or the
default) has no factory in `PLAN_CONFIG_FACTORIES`.

**Fix**: Check spelling against the 8 known languages (`rust`, `typescript`, `python`, `cpp`,
`haskell`, `julia`, `nix`, `shell`). All 8 are registered as of this pipeline version.

### "Baseline check failed... before any implementation attempt"

**Cause**: For Nix or Shell phases, the whole-repo validator (`nix flake check` or
`shellcheck`) was already failing on the untouched tree, unrelated to this run.

**Fix**: Fix the pre-existing issue in the repo directly (e.g. `nix flake check` locally to see
the failure), then re-run the pipeline. This is an environment error (exit code 3), not something
retries can fix.

### "Phase exhausted repair budget (exit code 2)"

**Cause**: A phase failed after local retries and fixer escalation.

**Fix**:

1. Review the error message in the pipeline output
2. Identify the root cause (compilation error, test failure, coverage gap, etc.)
3. Fix the issue manually:
   ```bash
   # Edit the code
   vim src/auth/mod.rs
   # Or adjust the plan
   vim plans/feature.md
   ```
4. Run the pipeline again to resume:
   ```bash
   bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md
   ```

### "Coverage gate failed" (Rust only)

**Cause**: Test coverage is below the threshold (default 90%).

**Fix**:

1. Add more tests to increase coverage
2. Or override the threshold in the plan file:
   ```markdown
   ## Phase 1: Implementation

   Commit message: feat: add module
   Coverage: 85%
   ```
3. Run the pipeline again

### "Unable to determine current git branch"

**Cause**: The workspace is not a git repository.

**Fix**: Initialize git:

```bash
cd ./my-project
git init
git config user.email "you@example.com"
git config user.name "Your Name"
git add .
git commit -m "initial commit"
bun run pipeline plan-cycle . --plan ../plans/feature.md
```

### "Unexpected error: <message>"

**Cause**: An unhandled error occurred (exit code 3).

**Fix**:

1. Check the error message for details
2. Verify the workspace path exists
3. Verify the plan file exists and is valid
4. Check that Ollama is running (if using the local profile)
5. Check that a GitHub Copilot token is set (if using copilot-default or hybrid)
6. Check that `ANTHROPIC_API_KEY` is set (if using anthropic-sonnet)
7. Check that `AWS_BEDROCK_INFERENCE_PROFILE_ARN` is set and AWS credentials are valid, e.g. via
   `aws sso login` (if using bedrock-sonnet)
8. Verify the resolved language's toolchain is available (see
   [`docs/plan-cycle-languages.md`](plan-cycle-languages.md) for required Nix flake tools)

---

## Examples

### Example 1: Simple Rust Feature

**Plan file** (`plans/simple.md`):

```markdown
# Feature: Add utility functions

## Phase 1: Create utils module

Commit message: feat: add utils module
Language: rust

### Step 1: Create utils module

Create src/utils/mod.rs with basic module structure and documentation.

### Step 2: Add helper functions

Add three helper functions:
- `parse_config(path: &str) -> Result<Config, Error>`
- `validate_input(input: &str) -> bool`
- `format_output(data: &str) -> String`
```

**Run**:

```bash
git checkout -b feat/utils
bun run pipeline plan-cycle ./my-project --plan ./plans/simple.md
```

### Example 2: Multi-Phase Feature with Coverage (Rust)

**Plan file** (`plans/auth.md`):

```markdown
# Feature: Add authentication module

## Phase 1: Create auth module

Commit message: feat: add auth module structure
Language: rust

### Step 1: Create auth module

Create src/auth/mod.rs with:
- Module documentation
- User struct with id, username, email fields
- AuthError enum with variants: InvalidCredentials, UserNotFound, DatabaseError

### Step 2: Add login function

Add login function to src/auth/mod.rs:
- Signature: `pub async fn login(username: &str, password: &str) -> Result<User, AuthError>`
- Validate inputs (non-empty)
- Return AuthError::InvalidCredentials if validation fails

## Phase 2: Add tests

Commit message: feat: add auth tests
Language: rust
Coverage: 85%

### Step 1: Add unit tests

Add comprehensive tests to src/auth/mod.rs:
- Test successful login
- Test invalid username
- Test invalid password
- Test empty credentials
```

**Run**:

```bash
git checkout -b feat/auth
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/auth.md
```

### Example 3: Resume After Failure

**Scenario**: Phase 1 passes, Phase 2 fails with coverage gap.

```bash
# Initial run
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/auth.md
# Exit code: 2 (Phase 2 failed)

# Fix the issue: add more tests
vim src/auth/mod.rs

# Resume
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/auth.md
# Exit code: 0 (Phase 2 now passes)
```

### Example 4: Polyglot Feature (Rust + TypeScript)

See [Example: Polyglot Plan File](#example-polyglot-plan-file) above.

---

## See Also

- [`README.md`](../README.md) — Quick start and pipeline overview
- [`docs/plan-cycle-languages.md`](plan-cycle-languages.md) — Full per-language reference:
  toolchain steps, flake tool prerequisites, `baselineCheck` languages, weak-verification caveats
- [`docs/memory-client.md`](memory-client.md) — Cerebrum memory system details
- [`docs/resume-workflow.md`](resume-workflow.md) — Deep dive into resume mechanism
