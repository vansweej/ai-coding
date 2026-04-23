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
      model-profiles.ts    ModelRole, ModelProfile, copilot-default profile
      pipeline-registry.ts Single source of truth for pipeline metadata
    core/
      mode-router/         source → AIMode ("editor" | "agentic")
      model-router/        action → ModelRole; role + profile → model ID
      orchestrator/        Single LLM call lifecycle; CopilotDispatcher
      pipeline/
        steps/             OrchestratorStep (LLM), NixShellStep, FileWriterStep
        definitions/       dev-cycle, rust-dev-cycle, cmake-dev-cycle, scaffold-*
    cli/
      parse-args.ts        CLI argument parsing (--profile, --input flags)
      load-config.ts       Builds OrchestratorConfig with copilot-default profile
      select-pipeline.ts   Instantiates pipeline by name
  opencode/
    mappings/              opencode.json (provider/model config, symlinked by Home Manager)
  .opencode/
    agents/                Project-local subagents (planner, debugger, reviewer, tester)
    commands/              Pipeline slash commands
  docs/                    Documentation (you are here)
  AGENTS.md                AI agent instructions for this repo
```

---

## Model Profiles

Model selection uses the **role/profile** system:

```
AIAction → ModelRole → ModelProfile → model ID → Dispatcher
```

### copilot-default (built-in default)

All roles route to `claude-sonnet-4.6` via GitHub Copilot:

| Role          | Model               | Backend     |
|---------------|---------------------|-------------|
| `planner`     | `claude-sonnet-4.6` | Copilot API |
| `implementer` | `claude-sonnet-4.6` | Copilot API |
| `debugger`    | `claude-sonnet-4.6` | Copilot API |
| `reviewer`    | `claude-sonnet-4.6` | Copilot API |
| `tester`      | `claude-sonnet-4.6` | Copilot API |
| `scaffolder`  | `claude-sonnet-4.6` | Copilot API |
| `explorer`    | `claude-sonnet-4.6` | Copilot API |

### Profile selection

| Priority | Source                          |
|----------|---------------------------------|
| Highest  | `--profile <name>` CLI flag     |
| Middle   | `AI_CODING_MODEL_PROFILE` env   |
| Default  | `copilot-default`               |

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

### GitHub Copilot authentication

All pipeline LLM calls use GitHub Copilot. Authenticate once:

```bash
opencode
# Inside the TUI: /connect → select "GitHub Copilot" → authorize in browser
```

The token is stored in `~/.local/share/opencode/auth.json`. The pipeline CLI
reads it automatically — no environment variable needed.

---

## Running Pipelines

### From the CLI

```bash
bun run pipeline <name> <workspace> [--input "task description"] [--profile <name>]
```

**Pipeline names:**

| Name              | Stack      | Steps                                                        |
|-------------------|------------|--------------------------------------------------------------|
| `dev-cycle`       | TypeScript | plan → implement → write-files → bun test                   |
| `rust-dev-cycle`  | Rust       | plan → implement → write-files → fmt → clippy → test → coverage |
| `cmake-dev-cycle` | C++        | plan → implement → write-files → configure → build → test   |
| `scaffold-rust`   | Rust       | cargo init + generate flake.nix                              |
| `scaffold-cpp`    | C++        | generate CMakeLists.txt + src/main.cpp + flake.nix           |

**Examples:**

```bash
# Scaffold a new Rust project
bun run pipeline scaffold-rust /tmp/my-rust-project

# Run the TypeScript dev cycle with a task
bun run pipeline dev-cycle ./my-project --input "Add retry logic to the HTTP client"

# Specify the model profile explicitly
bun run pipeline dev-cycle ./my-project --profile copilot-default --input "Add error handling"
```

### From OpenCode (slash command)

```
/pipeline rust-dev-cycle ./my-project "Add a JSON parser module"
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

**Examples:**

```
@planner I want to add retry logic to the HTTP client. What's the best approach?

@debugger The rust-dev-cycle pipeline is writing files to the wrong directory. Diagnose.

@reviewer Review the changes in the last commit for correctness and style.

@tester Add tests for the new actionToRole function in model-router.
```

---

## OpenCode Primary Agents

Four primary agents are available in the TUI (switch with **Tab**):

| Agent     | Model                  | Use when…                                        |
|-----------|------------------------|--------------------------------------------------|
| `build`   | claude-sonnet-4.6      | Default — full access, write files               |
| `plan`    | claude-opus-4.6        | Architecture decisions, deep analysis            |
| `local`   | claude-sonnet-4.6      | Experimentation, general-purpose                 |
| `explore` | claude-sonnet-4.6      | Read-only codebase exploration and Q&A           |

---

## Rules System (AGENTS.md)

OpenCode reads `AGENTS.md` files for project-specific instructions:

| Location                         | Scope                 |
|----------------------------------|-----------------------|
| `./AGENTS.md`                    | This project only     |
| `~/.config/opencode/AGENTS.md`   | All OpenCode sessions |

The project `AGENTS.md` contains build commands, code style rules, naming
conventions, and testing instructions. Every agent session loads it automatically.

---

## Daily Workflow

1. **Open OpenCode** — `cd my-project && opencode` (or just `opencode` from anywhere)
2. **Explore first** — switch to the `explore` agent (Tab), ask questions about unfamiliar code
3. **Plan** — switch to the `plan` agent, describe the change
4. **Implement** — switch to `build`, tell it to follow the plan
5. **Run a pipeline** — for self-contained tasks: `/pipeline dev-cycle . "Add error handling"`
6. **Review** — `@reviewer` checks the diff before committing
7. **Commit** — the `build` agent commits with conventional commit messages
