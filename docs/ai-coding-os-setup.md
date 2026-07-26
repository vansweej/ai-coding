# AI Coding OS with OpenCode - Setup Guide

## What Is the AI Coding OS?

The AI Coding OS is a TypeScript monorepo that routes coding requests to the most
appropriate LLM model and runs multi-step agentic pipelines (plan → implement →
write-files → test). It sits alongside **OpenCode** (the terminal-based AI coding
agent) and extends it with:

- Named **model profiles** that map semantic roles (planner, implementer, debugger…)
  to concrete model IDs
- **Pipeline definitions** that run the full dev cycle autonomously: plan → implement
  → write source files to disk → build/test
- **Subagents** for planning, debugging, code review, and test writing
- **Global deployment** via Home Manager so agents and pipelines are available in
  every project

---

## Architecture Overview

```
ai-coding/
  ai-system/
    config/
      model-profiles.ts    ModelRole, ModelProfile, local, copilot-default, hybrid, anthropic-sonnet, and bedrock-sonnet profiles
      pipeline-registry.ts Single source of truth for pipeline metadata
    core/
      mode-router/         source → AIMode ("editor" | "agentic")
      model-router/        action → ModelRole; role + profile → model ID
      orchestrator/        Single LLM call lifecycle; CopilotDispatcher, OllamaDispatcher, AnthropicDispatcher
      pipeline/
        steps/             OrchestratorStep (LLM), NixShellStep, FileWriterStep
        definitions/       plan-cycle, scaffold-rust, scaffold-cpp
    cli/
      parse-args.ts        CLI argument parsing (--profile, --input flags)
      load-config.ts       Builds OrchestratorConfig with local profile (Ollama-only)
      select-pipeline.ts   Instantiates pipeline by name
  opencode/
    mappings/              opencode.json (provider/model config, symlinked by Home Manager)
  docs/                    Documentation (you are here)
  AGENTS.md                AI agent instructions for this repo
```

---

## Model Profiles

Model selection uses the **role/profile** system:

```
AIAction → ModelRole → ModelProfile → model ID → Dispatcher
```

### local (built-in default)

All roles route to `gemma4:26b` via local Ollama:

| Role          | Model               | Backend |
|---------------|---------------------|---------|
| `planner`     | `gemma4:26b`        | Ollama  |
| `implementer` | `gemma4:26b`        | Ollama  |
| `debugger`    | `gemma4:26b`        | Ollama  |
| `reviewer`    | `gemma4:26b`        | Ollama  |
| `tester`      | `gemma4:26b`        | Ollama  |
| `scaffolder`  | `gemma4:26b`        | Ollama  |
| `explorer`    | `gemma4:26b`        | Ollama  |

### anthropic-sonnet

All roles route to `claude-sonnet-5` via the native Anthropic Messages API.
Requires the `ANTHROPIC_API_KEY` environment variable. Provider selection is
captured entirely in the profile — there is no separate model-override flag.

### bedrock-sonnet

All roles route to a Claude Sonnet model hosted on Amazon Bedrock via the
InvokeModel API. Requires `AWS_BEDROCK_INFERENCE_PROFILE_ARN` (a Bedrock
application inference profile ARN — never commit this, it embeds an AWS
account ID) plus AWS credentials resolved through the AWS SDK's default
provider chain, typically an `aws sso login` session selected via
`AWS_PROFILE`. The target region is parsed from the ARN, so `AWS_REGION`
need not be set separately.

```bash
aws sso login --profile my-company-profile
export AWS_PROFILE=my-company-profile
export AWS_BEDROCK_INFERENCE_PROFILE_ARN=arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/abc123
bun run pipeline plan-cycle ./my-project --profile bedrock-sonnet --input "Add error handling"
```

SSO session credentials expire after a bounded time (often 1–8 hours); start
long unattended runs right after a fresh `aws sso login`.

### Profile selection

| Priority | Source                          |
|----------|---------------------------------|
| Highest  | `--profile <name>` CLI flag     |
| Middle   | `AI_CODING_MODEL_PROFILE` env   |
| Default  | `local`                         |

---

## Prerequisites

Managed by Home Manager and assumed to be on PATH:

- **Bun** — TypeScript runtime and package manager
- **OpenCode** — AI coding agent (terminal UI)
- **Nix** (optional) — for nix-aware pipeline steps (`nix develop`)

Verify:

```bash
bun --version
opencode --version
```

### Ollama

All pipeline LLM calls use a local Ollama instance. Install and start it:

```bash
# Install Ollama (macOS / Linux)
brew install ollama       # macOS
# or: curl -fsSL https://ollama.com/install.sh | sh

# Start the server
ollama serve

# Pull required models
ollama pull gemma4:26b       # primary pipeline model (default profile)
ollama pull nomic-embed-text  # for codebase indexing and skill retrieval
```

---

## Running Pipelines

### From the CLI

```bash
bun run pipeline <name> <workspace> [--input "task description"] [--profile <name>]
```

**Pipeline names:**

| Name              | Stack | Steps                                                        |
|-------------------|-------|--------------------------------------------------------------|
| `plan-cycle`      | auto-routed (rust, typescript, python, cpp, haskell, julia, nix, shell) | plan → implement → verify (per-file toolchain) → coverage (Rust); resumable |
| `scaffold-rust`   | Rust  | cargo init + generate flake.nix                              |
| `scaffold-cpp`    | C++   | generate CMakeLists.txt + src/main.cpp + flake.nix           |

**Examples:**

```bash
# Scaffold a new Rust project
bun run pipeline scaffold-rust /tmp/my-rust-project

# Run plan-cycle with a plan file
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md

# Specify the model profile explicitly
bun run pipeline plan-cycle ./my-project --profile local --input "Add error handling"

# Use Anthropic Claude Sonnet via the native Messages API
export ANTHROPIC_API_KEY=sk-ant-...
bun run pipeline plan-cycle ./my-project --profile anthropic-sonnet --input "Add error handling"
```

### From OpenCode (slash command)

```
/pipeline plan-cycle ./my-project --plan ./plans/feature.md
```

The `/pipeline` command is installed globally via Home Manager and available in
every OpenCode session.

---

## Subagents

The following subagents are available in every OpenCode session (deployed globally
via Home Manager). Invoke them by prefixing a message with `@<name>`:

| Agent       | Model               | Role                              | Permissions          |
|-------------|---------------------|-----------------------------------|----------------------|
| `@planner`  | claude-sonnet-4.6   | Read-only planning and analysis   | read + git inspect   |
| `@debugger` | claude-sonnet-4.6   | Root-cause diagnosis              | read + bun test + git |
| `@reviewer` | claude-sonnet-4.6   | Code review (quality/security)    | read + bun test + git |
| `@tester`   | claude-sonnet-4.6   | Test writing and coverage         | read + bun test + git |

See [docs/agent-reference.md](./agent-reference.md) for full agent documentation.

**Examples:**

```
@planner I want to add retry logic to the HTTP client. What's the best approach?

@debugger The plan-cycle pipeline is writing files to the wrong directory. Diagnose.

@reviewer Review the changes in the last commit for correctness and style.

@tester Add tests for the new actionToRole function in model-router.
```

---

## OpenCode Primary Agents

Seven primary agents are available in the TUI (switch with **Tab**):

| Agent         | Model                  | Use when…                                                    |
|---------------|------------------------|--------------------------------------------------------------|
| `build`       | claude-sonnet-4.6      | Default — full access, write files                           |
| `plan`        | claude-opus-4.6        | Architecture decisions, deep analysis                        |
| `local`       | claude-sonnet-4.6      | Experimentation, general-purpose                             |
| `explore`     | claude-sonnet-4.6      | Read-only codebase exploration and Q&A                       |
| `spar`        | claude-opus-4.6        | Challenging a feature idea before investing in a plan        |
| `teach`       | claude-opus-4.6        | Learning — adaptive tutor grounded in project context        |
| `brainstorm`  | claude-opus-4.6        | Exploring new ideas — presents choices, researches prior art |

See [docs/agent-reference.md](./agent-reference.md) for full agent documentation, design
principles, and the brainstorm → spar → plan handoff workflow.

---

## Rules System (AGENTS.md and Skills)

OpenCode reads `AGENTS.md` files for project-specific instructions, and loads
**skills** on demand for language-specific guidance. The two mechanisms work
together at different scopes:

| Source | Scope | Loaded when |
|--------|-------|-------------|
| `~/.config/opencode/AGENTS.md` | All sessions | Always — language-agnostic workflow and build rules |
| `./AGENTS.md` | This project only | Always when present — project build commands and skill pointer |
| Language skill (`rust`, `cpp`) | On demand | When the agent recognises a language-specific task |

### Global AGENTS.md

Contains only language-agnostic rules: branch strategy, conventional commits,
coverage targets, and the Nix dev shell requirement. It does **not** contain
any language-specific coding standards.

### Language Skills

Language-specific coding standards, tooling, error handling, and review
checklists live in dedicated skills that are loaded on demand:

| Skill | Trigger keywords | Contents |
|-------|-----------------|----------|
| `rust` | rust, cargo, crate, Cargo.toml, clippy, tarpaulin | Core principles, error handling, tooling (cargo fmt/clippy/tarpaulin), safety, testing |
| `cpp` | c++, cpp, cmake, CMakeLists, clang, ctest | Core principles (RAII, smart pointers), error handling, tooling (clang-format/clang-tidy/ctest), testing |
| `debugger` | debug, diagnose, trace, root cause, error, fix | Root-cause tracing, minimal fix proposal, post-fix verification |

### Project-Local AGENTS.md

Each project can have its own `AGENTS.md` with project-specific build commands
and a pointer to the relevant language skill. Scaffold pipelines (`scaffold-rust`,
`scaffold-cpp`) generate this file automatically in new projects.

---

## Daily Workflow

### Quick path (most common)

1. **Index your repo** — `cd my-project && index-codebase` (first time, or after large changes)
2. **Open OpenCode** — `opencode` (or just `opencode` from anywhere)
3. **Explore first** — switch to the `explore` agent (Tab), ask questions about unfamiliar code
4. **Plan** — switch to the `plan` agent, describe the change
5. **Implement** — switch to `build`, tell it to follow the plan
6. **Run a pipeline** — for self-contained tasks: `/pipeline plan-cycle . --input "Add error handling"`
7. **Review** — `@reviewer` checks the diff before committing
8. **Commit** — the `build` agent commits with conventional commit messages

---

## Neovim Inline Prompts

The `opencode.nvim` plugin exposes inline prompt actions via `<leader>os`
(action selector) and `<leader>oa` (ask with context). These communicate with
the OpenCode server over HTTP.

### Prompts

| Keymap | Action | Type |
|--------|--------|------|
| `<leader>os → explain` | Explain selected code | Fast (no tools) |
| `<leader>os → diagnostics` | Explain LSP diagnostics | Fast (no tools) |
| `<leader>os → document` | Add doc comments to selection (loads documenter skill) | Full (tool-aware) |
| `<leader>os → optimize` | Optimize selection for performance (loads programmer skill) | Full (tool-aware) |
| `<leader>os → review` | Review selection (loads reviewer skill) | Full (tool-aware) |
| `<leader>os → implement` | Implement selection (loads programmer skill) | Full (tool-aware) |
| `<leader>os → test` | Write tests for selection (loads tester skill) | Full (tool-aware) |
| `<leader>os → fix` | Fix diagnostics (loads debugger skill) | Full (tool-aware) |
| `<leader>os → diff` | Review git diff (loads reviewer skill) | Full (tool-aware) |

**Fast prompts** respond immediately from the injected context — no tool calls,
no skill loading. Use these for quick, self-contained questions about visible code.

**Full prompts** load the matching skill and use tools to read related files,
run tests, and gather context before responding. They apply changes **directly
to the source file** rather than displaying them in chat. All full prompts
require the `build` or `local` agent to be active.

### Known issue: multiple OpenCode instances

If multiple OpenCode instances are running (e.g. from multiple Neovim sessions
or a standalone `opencode` invocation), the plugin cannot determine which server
to target. The prompt picker appears, you select an action, but nothing happens.

**Fix:** ensure only one OpenCode instance is running:

```bash
pkill opencode
```

Then use `<leader>ot` in Neovim to start a fresh instance before triggering prompts.

Use this when you need to understand a concept or pattern before implementing:

1. **Open OpenCode** — `cd my-project && opencode`
2. **Learn** — switch to `teach`, ask about the concept or pattern you need to understand; it reads the project and fetches external docs to ground the lesson
3. **Explore** — switch to `explore`, trace the relevant code with your new understanding
4. **Plan** — switch to `plan`, describe the change
5. **Implement** — switch to `build`, follow the plan
6. **Review** — `@reviewer` checks the diff before committing
7. **Commit** — the `build` agent commits with conventional commit messages
