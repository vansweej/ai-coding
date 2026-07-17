# Rust Plan Cycle (`rust-plan-cycle`) — Comprehensive Guide

The `rust-plan-cycle` pipeline is an unattended, multi-phase Rust implementation engine designed
for CI/CD workflows and autonomous agent execution. It combines structured planning, automatic
repair, memory tracking, and resumable failures into a single cohesive system.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Plan File Format](#plan-file-format)
4. [Usage](#usage)
5. [Resume Workflow](#resume-workflow)
6. [Memory Client Integration](#memory-client-integration)
7. [Exit Codes](#exit-codes)
8. [Troubleshooting](#troubleshooting)
9. [Examples](#examples)

---

## Overview

### What is rust-plan-cycle?

`rust-plan-cycle` is a pipeline that:

1. **Parses a structured plan file** into phases and steps
2. **Executes each phase sequentially**, implementing all steps before committing
3. **Verifies each phase** with the Rust toolchain (fmt, check, clippy, test, coverage)
4. **Retries locally** when verification fails, with diagnostics
5. **Escalates to Copilot** if local retries are exhausted
6. **Commits each phase** with a `Phase: N` trailer for resume tracking
7. **Tracks progress in memory** (Cerebrum two-tier memory system)
8. **Resumes from the last completed phase** if interrupted

### Key Differences from `dev-cycle`

| Feature | `dev-cycle` | `rust-plan-cycle` |
|---------|------------|-------------------|
| Execution | Interactive (human-in-the-loop) | Unattended (fully autonomous) |
| Repair | Local retries only | Local retries + Copilot escalation |
| Memory | None | Two-tier (Synapse + Cortex) |
| Resume | Manual (git-based) | Automatic (git + memory) |
| Coverage | Warning-only | Fatal (blocks phase) |
| Format | Auto-check only | Auto-fix (cargo fmt) |
| Branch | Any branch | Feature branch only |

---

## Architecture

### Pipeline Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Parse Plan File                                          │
│    - Extract feature name, phases, steps                    │
│    - Validate plan structure                                │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Detect Resume State (if needed)                          │
│    - Check git log for Phase: N trailers                    │
│    - Reset to last completed phase if dirty                 │
│    - Skip completed phases                                  │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. For Each Phase:                                          │
│    a. Store phase context in memory (salience 0.8)          │
│    b. Implement all steps                                   │
│    c. Store responses in memory (salience 0.6)              │
│    d. Verify with toolchain (fmt, check, clippy, test)      │
│    e. Retry locally if verification fails                   │
│    f. Escalate to Copilot if retries exhausted              │
│    g. Commit phase with Phase: N trailer                    │
│    h. Store completion in memory (salience 0.9)             │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Exit with Status Code                                    │
│    - 0: all phases passed                                   │
│    - 2: phase exhausted repair budget (resumable)           │
│    - 3: input/environment error                             │
└─────────────────────────────────────────────────────────────┘
```

### Verification Steps (per phase)

After all implementation steps in a phase, the following verification steps run:

1. **`cargo fmt --check`** → Auto-fix with `cargo fmt` (not just check)
2. **`cargo check --quiet`** → Ensure code compiles
3. **`cargo clippy -- -D warnings`** → Lint with strict warnings
4. **`cargo test`** → Run all tests
5. **`cargo tarpaulin`** → Measure coverage
6. **Coverage gate** → Enforce threshold (default 90%, fatal)

If any step fails, the phase enters the retry loop.

### Retry Loop

When verification fails:

1. **Local retries** (up to `--max-retries`, default 3):
   - Run the fixer role to diagnose and repair
   - Re-verify with the toolchain
   - If successful, continue to next phase
   - If still failing, proceed to escalation

2. **Copilot escalation** (if local retries exhausted):
   - Route to `claude-sonnet-4.6` (GitHub Copilot)
   - Provide full context (error, code, diagnostics)
   - Attempt one final fix
   - If successful, continue to next phase
   - If still failing, exit with code 2 (resumable failure)

---

## Plan File Format

### Structure

```markdown
# Feature: <feature name>

## Phase N: <phase title>

Commit message: <conventional commit message>

### Step N: <step title>

<step instruction>
```

### Rules

- **Feature name**: Single line after `# Feature:`
- **Phase number**: Must be sequential (1, 2, 3, …)
- **Phase title**: Short description of the phase
- **Commit message**: Conventional commit format (feat:, fix:, refactor:, etc.)
- **Step number**: Must be sequential within each phase (1, 2, 3, …)
- **Step title**: Short description of the step
- **Step instruction**: Plain text instruction for the LLM (can span multiple lines)

### Coverage Directives

Add coverage directives to exempt specific files or patterns:

```markdown
## Phase 1: Implementation

Commit message: feat: add core module

<!-- coverage: exempt-zero-line-additions -->

### Step 1: Create module

Create src/lib.rs with basic structure.
```

Supported directives:

- `<!-- coverage: exempt-zero-line-additions -->` — Exempt files with zero real lines added (test files, comments)
- `<!-- coverage: exempt-files src/bin/* -->` — Exempt specific file patterns
- `<!-- coverage: threshold 85 -->` — Override coverage threshold for this phase (default 90)

### Example Plan File

```markdown
# Feature: Add authentication module

## Phase 1: Create auth module

Commit message: feat: add auth module structure

### Step 1: Create auth module

Create src/auth/mod.rs with the following:
- Module-level documentation
- Basic module structure
- Placeholder for login function

### Step 2: Add login function

Add a login function to src/auth/mod.rs:
- Takes username and password as parameters
- Returns Result<User, AuthError>
- Validates input (non-empty username and password)

## Phase 2: Add tests

Commit message: feat: add auth tests

### Step 1: Add unit tests

Add comprehensive unit tests to src/auth/mod.rs:
- Test successful login
- Test invalid username
- Test invalid password
- Test empty credentials
```

---

## Usage

### Basic Command

```bash
bun run pipeline rust-plan-cycle <workspace> --plan <file> [options]
```

### Options

| Option | Description | Default |
|--------|-------------|---------|
| `--plan <file>` | Path to plan file (required) | — |
| `--language rust` | Language (always rust for this pipeline) | rust |
| `--max-retries <n>` | Max local retries per phase | 3 |
| `--profile <name>` | Model profile (local, copilot-default, hybrid, anthropic-sonnet) | copilot-default |

### Examples

```bash
# Run a plan from a feature branch
git checkout -b feat/auth-module
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/auth.md

# Run with custom retry count
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/auth.md --max-retries 5

# Run with local profile (no Copilot)
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/auth.md --profile local

# Run with hybrid profile (local for implementation, Copilot for escalation)
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/auth.md --profile hybrid

# Run with Anthropic Claude Sonnet (native Messages API)
ANTHROPIC_API_KEY=sk-ant-... bun run pipeline rust-plan-cycle ./my-project --plan ./plans/auth.md --profile anthropic-sonnet
```

> **Note:** `rust-plan-cycle` parses its plan from the `--plan` file rather
> than generating it via an LLM, so the `planner` role never fires on this
> path. Only the `implementer` role (action `edit`, used for initial
> implementation and local retries) and the `fixer` role (action `fix`, used
> for escalation attempts) actually dispatch LLM calls — so under
> `anthropic-sonnet` those are the two roles that run on Claude Sonnet.

### Branch Requirement

`rust-plan-cycle` **must run on a dedicated feature branch**. Protected branches are rejected:

- ❌ `main`
- ❌ `master`
- ❌ `develop`
- ❌ `development`

Create a feature branch before running:

```bash
git checkout -b feat/my-feature
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
```

---

## Resume Workflow

### Automatic Resume Detection

If a phase fails and exits with code 2, the pipeline can be resumed:

```bash
# Phase 1 fails, exits with code 2
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
# Exit code: 2

# Fix the issue (manually or wait for next attempt)
# Then run the same command again
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
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
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
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
     "model": "gemma4:26b",
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
| **3** | Input/environment error | Fix the error and retry |

### Exit Code 0 (Success)

All phases completed successfully. The feature branch is ready to merge:

```bash
git push origin feat/my-feature
# Create a pull request
```

### Exit Code 2 (Resumable Failure)

A phase failed after exhausting local retries and Copilot escalation. The pipeline
can be resumed after fixing the issue:

```bash
# Review the error message
# Fix the issue manually (edit code, adjust plan, etc.)
# Run the pipeline again
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
# Exit code: 0 (if successful) or 2 (if another phase fails)
```

### Exit Code 3 (Environment Error)

An input or environment error occurred. Examples:

- Bad plan file format
- Running on a protected branch (main, master, develop)
- Missing Rust toolchain
- Invalid workspace path

Fix the error and retry:

```bash
# Example: wrong branch
git checkout -b feat/my-feature
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
```

---

## Troubleshooting

### "Error: rust-plan-cycle must run on a dedicated feature branch"

**Cause**: You are on a protected branch (main, master, develop, development).

**Fix**: Create a feature branch:

```bash
git checkout -b feat/my-feature
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
```

### "Phase exhausted repair budget (exit code 2)"

**Cause**: A phase failed after local retries and Copilot escalation.

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
   bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
   ```

### "Coverage gate failed"

**Cause**: Test coverage is below the threshold (default 90%).

**Fix**:

1. Add more tests to increase coverage
2. Or override the threshold in the plan file:
   ```markdown
   ## Phase 1: Implementation

   <!-- coverage: threshold 85 -->

   Commit message: feat: add module
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
bun run pipeline rust-plan-cycle . --plan ../plans/feature.md
```

### "Unexpected error: <message>"

**Cause**: An unhandled error occurred (exit code 3).

**Fix**:

1. Check the error message for details
2. Verify the workspace path exists
3. Verify the plan file exists and is valid
4. Check that Ollama is running (if using local profile)
5. Check that GitHub Copilot token is set (if using copilot-default or hybrid profile)
6. Check that `ANTHROPIC_API_KEY` is set (if using anthropic-sonnet profile)

---

## Examples

### Example 1: Simple Feature

**Plan file** (`plans/simple.md`):

```markdown
# Feature: Add utility functions

## Phase 1: Create utils module

Commit message: feat: add utils module

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
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/simple.md
```

### Example 2: Multi-Phase Feature with Coverage

**Plan file** (`plans/auth.md`):

```markdown
# Feature: Add authentication module

## Phase 1: Create auth module

Commit message: feat: add auth module structure

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

<!-- coverage: threshold 85 -->

Commit message: feat: add auth tests

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

---

## See Also

- [`README.md`](../README.md) — Quick start and pipeline overview
- [`docs/memory-client.md`](memory-client.md) — Cerebrum memory system details
- [`docs/resume-workflow.md`](resume-workflow.md) — Deep dive into resume mechanism
