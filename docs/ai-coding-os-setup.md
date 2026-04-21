# AI Coding OS with OpenCode - Setup Guide

## What Is an AI Coding OS?

An AI Coding OS is a system that sits between you and multiple LLM models,
routing each coding task to the most appropriate model. Instead of using a
single model for everything, the system picks the right tool for the job:

- A powerful cloud model (Claude Sonnet) for high-level planning
- A specialized coding model (DeepSeek Coder V2) for debugging
- A fast local model (Qwen 2.5 Coder 7B) for quick edits and completions

The "OS" part comes from the orchestration layer that manages context, mode
detection, and request lifecycle -- similar to how an operating system manages
processes and resources.

**OpenCode** is the terminal-based AI coding agent that serves as the primary
interface. It provides the TUI, agent system, tool calling, and provider
management. Your custom routing logic plugs in alongside it.

---

## Architecture Overview

```
ai-coding/                           Managed as a git repo; consumed by Home Manager
  ai-system/
    core/
      model-router/      Select model based on action + operating mode
      mode-router/       Detect if running in editor or agentic context [planned]
      orchestrator/      Coordinate the full request lifecycle [planned]
    shared/
      event-types.ts     Shared types: AIRequestEvent, AIAction, AIModeHint, etc.
  opencode/
    mappings/            Provider/model configs (Home Manager symlinks these) [planned]
    profiles/            Agent profiles (Home Manager symlinks these) [planned]
  docs/                  You are here
  AGENTS.md              Instructions for AI coding agents working in this repo
```

### How the pieces fit together

1. A request arrives (from Neovim, CLI, or an agent) as an `AIRequestEvent`
2. The **mode-router** determines the operating mode (`editor` or `agentic`)
3. The **model-router** picks the best model for the action + mode combination
4. The **orchestrator** sends the request to the chosen model and returns results

### Event types (`shared/event-types.ts`)

The shared types define the contract between all components:

```typescript
type AISource = "nvim" | "cli" | "agent" | "api";
type AIModeHint = "editor" | "agentic" | "auto";
type AIAction = "explain" | "edit" | "refactor" | "plan" | "debug" | "chat" | "task";

type AIRequestEvent = {
  id: string;
  timestamp: number;
  source: AISource;
  modeHint?: AIModeHint;
  action: AIAction;
  payload: {
    input?: string;
    file?: string;
    selection?: string;
    workspace?: string;
    metadata?: Record<string, any>;
  };
  context?: Record<string, any>;
};
```

### Model routing logic (`core/model-router/select-model.ts`)

The current routing strategy:

| Action   | Mode     | Model                | Where       |
|----------|----------|----------------------|-------------|
| plan     | agentic  | `claude-sonnet`      | Cloud API   |
| debug    | agentic  | `deepseek-coder-v2`  | Local/Ollama|
| *other*  | agentic  | `qwen3:8b`  | Local/Ollama|
| *any*    | editor   | `qwen3:8b`  | Local/Ollama|

**Why this split?**

- **Planning** needs strong reasoning and broad knowledge -- Claude Sonnet
  excels here but costs money per request, so it is reserved for high-value
  tasks.
- **Debugging** benefits from deep code understanding -- DeepSeek Coder V2 is
  strong at code analysis and runs locally for free.
- **Everything else** (edits, completions, refactoring, chat) uses Qwen 2.5
  Coder 7B locally. It is fast, free, and good enough for routine work.

---

## Prerequisites

The following are managed by Home Manager (NixOS) and assumed to be available:

- **Bun** -- TypeScript runtime and package manager
- **Ollama** -- Local model server (service managed by Home Manager)
- **OpenCode** -- AI coding agent (terminal UI)

Ollama runs as a systemd service via Home Manager. The models
`deepseek-coder-v2` and `qwen3:8b` should already be pulled. Verify
with:

```bash
ollama list                # both models should appear
bun --version              # confirm Bun is on PATH
opencode --version         # confirm OpenCode is on PATH
```

If a model is missing, pull it manually: `ollama pull deepseek-coder-v2` or
`ollama pull qwen3:8b`.

This repository is intended to be consumed by Home Manager as well -- the
`opencode/` directory will contain provider mappings and agent profiles that
Home Manager can symlink into `~/.config/opencode/`.

---

## Step 1: Configure OpenCode with Ollama

### Register Ollama as a provider

Create (or edit) `opencode.json` in the project root (`ai-coding/`). Home
Manager can symlink this into place, or it can be committed directly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "deepseek-coder-v2": {
          "name": "DeepSeek Coder V2 (local)"
        },
        "qwen3:8b": {
          "name": "Qwen 2.5 Coder 7B (local)"
        }
      }
    }
  },
  "model": "ollama/qwen3:8b"
}
```

This registers both local models under an `ollama` provider and sets
`qwen3:8b` as the default.

### Initialize the project

```bash
cd /path/to/ai-coding
opencode
# Inside the TUI:
/init
```

This analyzes your project and may update the `AGENTS.md` file.

---

## Step 2: Set Up Model Routing

With Ollama running and the default model set, you now configure the two
specialist subagents and connect GitHub Copilot for cloud-powered planning.

### How routing works in practice

There are two layers:

**Today (manual, via subagents)**

| What you type | Model used | Why |
|---|---|---|
| Normal prompt (default) | `ollama/qwen3:8b` | Fast, local, free -- covers all routine edits |
| `@planner <task>` | `copilot/claude-sonnet-4.6` | Strong reasoning for architecture and planning |
| `@debugger <bug>` | `ollama/deepseek-coder-v2` | Deep code analysis for root-cause diagnosis |

**Later (automatic, via orchestrator -- planned)**

Once the `mode-router` and `orchestrator` are built, routing happens
automatically based on the request source and action:

| Source | Resolved mode | Action | Model |
|---|---|---|---|
| `nvim` | `editor` | any | `qwen3:8b` |
| `cli` / `agent` | `agentic` | `plan` | `claude-sonnet` |
| `cli` / `agent` | `agentic` | `debug` | `deepseek-coder-v2` |
| `cli` / `agent` | `agentic` | other | `qwen3:8b` |

The `source: "nvim"` field in `AIRequestEvent` is what the mode-router will
use to detect editor context and lock the model to qwen regardless of action.

### Connect GitHub Copilot

GitHub Copilot is a built-in provider -- no `opencode.json` changes needed.
Just authenticate once:

```bash
opencode
# Inside the TUI:
/connect
# Search for "GitHub Copilot", select it
# Navigate to https://github.com/login/device and enter the device code shown
# Authorize in the browser, then return to the TUI
```

The token is stored in `~/.local/share/opencode/auth.json`. To confirm the
models available under your subscription:

```bash
/models
# Look for entries starting with "copilot/"
# e.g. copilot/claude-sonnet-4.6
```

If the model ID shown differs from `claude-sonnet-4.6`, update the
`model:` field in `.opencode/agents/planner.md` to match exactly.

### Custom agent profiles

Two subagent profiles are defined in `.opencode/agents/`:

```
.opencode/
  agents/
    planner.md    -- Claude Sonnet via Copilot; read-only; invoke with @planner
    debugger.md   -- DeepSeek Coder V2 via Ollama; read-only; invoke with @debugger
```

Both agents have `edit: deny` and `write: deny` -- they diagnose and plan but
never touch files. The primary agent (qwen by default) does the actual work.

**Usage examples:**

```
# Plan a new feature before building it
@planner I want to add a mode-router that detects whether a request comes
from Neovim or the CLI. How should it work?

# Debug a failing test
@debugger The selectModel test for "debug" action is returning qwen instead
of deepseek. Here is the error: ...
```

### Daily workflow with routing

1. **Neovim (editor mode)** -- qwen handles everything automatically via the
   Neovim plugin or LSP integration. Fast, local, no API costs.
2. **Terminal planning** -- run `opencode`, use `@planner` to think through
   the approach before writing code.
3. **Terminal building** -- default agent (qwen) implements the plan. Switch to
   a cloud model temporarily with `/models` if you need stronger code generation.
4. **Debugging** -- use `@debugger` to diagnose; let the default agent apply
   the fix once the root cause is identified.

---

## Step 3: Verify the Setup

```bash
# Start OpenCode in the project
cd /path/to/ai-coding
opencode

# Switch models with /models to confirm both Ollama models appear
/models

# Test a prompt
How does the selectModel function route requests?
```

You should see your local Ollama models listed alongside any cloud providers.

---

## OpenCode Agents and Modes

OpenCode has two primary modes you switch between with **Tab**:

### Build Mode (default)

Full access to all tools: file reads/writes, bash commands, editing. Use this
when you want the agent to make changes.

### Plan Mode

Read-only. The agent analyzes code and suggests plans without modifying
anything. Use this to review approach before committing to changes.

### Subagents

OpenCode also has subagents that the primary agent can delegate to:

- **General** -- Multi-step research and task execution (has write access)
- **Explore** -- Fast, read-only codebase search (no write access)

You can invoke subagents manually with `@general` or `@explore` in your
message.

### Custom agents

Define your own agents in `.opencode/agents/` or `~/.config/opencode/agents/`
as markdown files. Example for a debug-focused agent:

```markdown
---
description: Debugging assistant using DeepSeek Coder V2
mode: subagent
model: ollama/deepseek-coder-v2
tools:
  write: false
  edit: false
---

You are a debugging specialist. Analyze code for bugs, trace execution paths,
and explain root causes. Do not make changes -- only diagnose.
```

---

## Rules System (AGENTS.md)

OpenCode reads `AGENTS.md` files for project-specific instructions:

| Location                           | Scope                    |
|------------------------------------|--------------------------|
| `./AGENTS.md`                      | This project only        |
| `~/.config/opencode/AGENTS.md`     | All OpenCode sessions    |

The project `AGENTS.md` at the repo root contains build commands, code style
rules, naming conventions, and testing instructions. Every agent session loads
it automatically.

You can also point to additional instruction files in `opencode.json`:

```json
{
  "instructions": ["docs/guidelines.md", ".cursor/rules/*.md"]
}
```

---

## Daily Workflow

1. **Open your project**: `cd ai-coding && opencode`
   (Ollama is already running as a systemd service via Home Manager)
2. **Plan first** -- Press Tab to switch to Plan mode, describe what you want
3. **Review the plan** -- Iterate on the approach until it looks right
4. **Build** -- Press Tab to switch to Build mode, tell it to proceed
5. **Test** -- Ask the agent to run `bun test` and fix any failures
6. **Commit** -- Agent can commit for you with conventional commit messages

For quick tasks (typo fixes, small refactors), skip planning and go straight
to Build mode.

---

## Next Steps

This project is in its early stages. Here is what needs to be built:

1. **Initialize the project** -- `bun init`, create `tsconfig.json`, add
   Biome config, set up `package.json` scripts
2. **Add types to model-router** -- The `selectModel` function parameters
   are currently untyped; wire up the shared `AIRequestEvent` and `AIModeHint`
   types
3. **Write tests** -- Create `select-model.test.ts` with full coverage of
   the routing logic
4. **Implement mode-router** -- Detect whether a request is coming from an
   editor context or an agentic context
5. **Implement orchestrator** -- Coordinate the full lifecycle: receive
   event, determine mode, select model, dispatch request, return result
6. **Set up OpenCode mappings** -- Populate `opencode/mappings/` with
   provider configs and `opencode/profiles/` with agent profiles that Home
   Manager can symlink into `~/.config/opencode/`
7. **Add CI** -- GitHub Actions for type-check, lint, test on every push
