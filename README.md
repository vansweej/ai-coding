# ai-coding

A TypeScript monorepo for an AI coding OS that routes requests to different LLM models based on
task type and runs multi-step agent pipelines for planning, implementing, and verifying code.

## Architecture

- **Model profiles** -- named configurations mapping semantic roles (planner, implementer,
  debugger, fixer…) to model IDs. Default: `local` (all roles → `gemma4:26b` via local Ollama).
  No cloud dependencies or API tokens required.
- **Pipelines** -- plan-file driven workflows that implement steps, write files, verify with the
  language toolchain, retry locally, escalate fixes when needed, and commit each successful phase.
- **Scaffold pipelines** -- generate new Rust and C++ projects including a `flake.nix` dev shell
  and a lightweight `AGENTS.md` with build commands and a language-skill reference
- **Codebase indexer** -- indexes git repositories into a local LanceDB vector store using
  tree-sitter WASM chunking and Ollama embeddings, enabling semantic code retrieval across
  sessions. See [`docs/codebase-indexer.md`](docs/codebase-indexer.md) for full documentation

---

## Configuration

---

### Monorepo path (required for global OpenCode integration)

When invoking pipelines from a different project directory via OpenCode's slash
commands or the custom tool, the pipeline CLI needs to know where the
`ai-coding` monorepo lives.

If you use **Home Manager**, `AI_CODING_MONOREPO` is set automatically in
`home.sessionVariables` to the Nix store path of the built ai-coding package.
No manual export or local clone is needed.

For non-Home-Manager setups, set it to the absolute path of your local clone:

```bash
export AI_CODING_MONOREPO=/path/to/ai-coding
```

If the variable is not set, the slash commands will silently fail and the
custom tool will return an explicit error message.

---

## Running pipelines

```bash
bun run pipeline <name> <workspace> [--plan <file> | --input "request text"] [--language <typescript|rust|cpp>] [--max-retries <n>] [--profile <name>]
```

| Pipeline name     | Steps                                                              | Language   |
|-------------------|--------------------------------------------------------------------|------------|
| `scaffold-rust`   | cargo init → generate flake.nix → write files → write AGENTS.md               | Rust       |
| `scaffold-cpp`    | generate files → write files → cmake configure → write AGENTS.md               | C++        |
| `dev-cycle`       | plan file → implement steps → verify/retry → per-phase commit       | TS/Rust/C++|
| `rust-dev-cycle`  | alias for `dev-cycle --language rust`                              | Rust       |
| `cmake-dev-cycle` | alias for `dev-cycle --language cpp`                               | C++        |
| `rust-plan-cycle` | unattended plan execution with memory tracking and resumable failures | Rust       |

## Codebase indexer

Index a git repository for semantic code search:

```bash
# Via bun run (from the ai-coding monorepo directory)
bun run index-codebase <repo-path> [--force] [--ttl <days>]
bun run index-codebase --purge-repo <path>   # remove a specific repo (no Ollama needed)
bun run codebase-retrieval <query> [--workspace <path>] [--limit <n>] [--no-refresh]
```

If the shell wrappers are installed via Home Manager (`home-manager switch`),
you can run from any repository directory without referencing the monorepo:

```bash
# From inside any git repo
index-codebase              # index current directory
index-codebase --force      # force full re-index
index-codebase --purge-only          # purge stale rows only (no Ollama needed)
index-codebase --purge-repo /old/repo  # remove a specific repo (no Ollama needed)

codebase-retrieval "my query"              # search current repo
codebase-retrieval "my query" --no-refresh # skip incremental re-index
```

Requires Ollama running locally with the `nomic-embed-text` model:

```bash
ollama serve
ollama pull nomic-embed-text
```

See [`docs/codebase-indexer.md`](docs/codebase-indexer.md) for full CLI reference,
environment variables, and language support.

### Examples

```bash
# Scaffold a new Rust project
mkdir /tmp/my-rust-project
bun run pipeline scaffold-rust /tmp/my-rust-project

# Scaffold a new C++ project
mkdir /tmp/my-cpp-project
bun run pipeline scaffold-cpp /tmp/my-cpp-project

# Run the dev cycle from a structured plan file (uses local profile by default)
bun run pipeline dev-cycle ./my-project --plan ./plans/feature.md

# Run a backward-compatible single-step Rust request
bun run pipeline dev-cycle ./my-rust-project --language rust --input "Add a config module"

# Run the unattended Rust plan cycle (requires feature branch)
bun run pipeline rust-plan-cycle ./my-rust-project --plan ./plans/feature.md
```

All shell steps are nix-aware: if a `flake.nix` is detected in the workspace, commands are
wrapped in `nix develop --command`.

Pipelines require **Ollama** running locally with the required model:

```bash
ollama serve
ollama pull gemma4:26b       # required for the local profile (default)
ollama pull nomic-embed-text  # required for codebase indexing and skill retrieval
```

---

## Unattended Rust Plan Cycle (`rust-plan-cycle`)

The `rust-plan-cycle` pipeline executes multi-phase Rust plans **unattended** with automatic
repair, memory tracking, and resumable failures. It is designed for CI/CD workflows and
autonomous agent execution.

### Key Features

- **Unattended execution**: Runs all phases without human intervention
- **Automatic repair**: Retries failed steps locally with diagnostics; escalates to Copilot if needed
- **Memory tracking**: Stores phase context and completion status for resumability
- **Resumable failures**: Exit code 2 indicates a phase exhausted its repair budget but can be resumed
- **Branch enforcement**: Must run on a dedicated feature branch (not main/master/develop)
- **Fatal coverage gate**: Coverage threshold is enforced; failures block the phase
- **Auto-format**: `cargo fmt` runs automatically (not just check)

### Usage

```bash
# Run from a feature branch (required)
git checkout -b feat/my-feature

# Execute the plan
bun run pipeline rust-plan-cycle ./my-rust-project --plan ./plans/feature.md

# Exit codes:
#   0 = all phases passed
#   2 = phase exhausted repair budget (resumable — run again to continue)
#   3 = input/environment error (bad plan, wrong branch, missing toolchain)
```

### Plan File Format

Create a plan file with phases and steps:

```markdown
# Feature: Add authentication module

## Phase 1: Create auth module

Commit message: feat: add auth module structure

### Step 1: Create auth module

Create src/auth/mod.rs with basic module structure.

### Step 2: Add login function

Add a login function to src/auth/mod.rs.

## Phase 2: Add tests

Commit message: feat: add auth tests

### Step 1: Add unit tests

Add comprehensive unit tests to src/auth/mod.rs.
```

Each phase is committed separately with a `Phase: N` trailer for resume tracking.

### Resume Workflow

If a phase fails and exhausts its repair budget (exit code 2):

```bash
# Fix the issue manually or wait for the next retry
# Then resume from where it left off
bun run pipeline rust-plan-cycle ./my-rust-project --plan ./plans/feature.md

# The pipeline detects the last completed phase and skips to the next one
# No need to manually reset or specify a starting phase
```

The resume mechanism uses git commit trailers (`Phase: N`) to detect the last completed phase.
If the working directory is dirty, the pipeline resets to the last phase commit before resuming.

### Memory Client Integration

Phase context and completion status are stored in a two-tier memory system (Synapse + Cortex)
via the Cerebrum MCP server. This enables:

- **Phase tracking**: Each phase stores its context (number, title, commit message, step count)
- **Completion tracking**: Completion status with timestamp and steps completed
- **Resumability**: Memory is consulted during resume to understand prior progress
- **Salience-based prioritization**: Phase context (0.8) and completion (0.9) are high-priority

Memory is optional — if the Cerebrum server is unavailable, the pipeline continues with
git-based resume only.

### Exit Code Contract

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| 0 | All phases passed | Feature is complete |
| 2 | Phase exhausted repair budget | Fix the issue and run again to resume |
| 3 | Input/environment error | Fix the error (bad plan, wrong branch, missing toolchain) and retry |

### Troubleshooting

**"Error: rust-plan-cycle must run on a dedicated feature branch"**
- You are on main, master, or develop
- Create a feature branch: `git checkout -b feat/my-feature`

**"Phase exhausted repair budget (exit code 2)"**
- The phase failed after local retries and Copilot escalation
- Review the error message and fix the issue manually
- Run the pipeline again to resume from the next phase

**"Coverage gate failed"**
- Test coverage is below the threshold (default 90%)
- Add more tests or adjust the coverage directive in the plan file
- See [`docs/rust-plan-cycle.md`](docs/rust-plan-cycle.md) for coverage directives

See [`docs/rust-plan-cycle.md`](docs/rust-plan-cycle.md) for full documentation.

---

## OpenCode integration

Pipelines can be invoked directly from the OpenCode TUI in two ways.

### Slash commands (explicit)

Type a slash command in the TUI to run a pipeline. The pipeline output is fed
back to the LLM, which summarises what happened.

| Command | What it does |
|---------|-------------|
| `/scaffold-rust <path>` | Scaffold a Rust project with Nix flake |
| `/scaffold-cpp <path>` | Scaffold a C++ project with CMakeLists.txt and Nix flake |
| `/pipeline <name> <path> [--input "..."]` | Run any pipeline by name |

Examples:

```
/scaffold-rust /tmp/my-rust-project
/scaffold-cpp /tmp/my-cpp-project
/pipeline rust-dev-cycle ./my-project --input "Add a config module"
```

Command files are deployed globally to `~/.config/opencode/commands/` via Home Manager.
Add new ones in `~/Projects/home-manager/opencode/commands/` and run `home-manager switch`.

---

### Custom tool (conversational)

A custom tool deployed globally at `~/.config/opencode/tools/pipeline.ts` via Home Manager lets the LLM call
pipelines autonomously during a conversation. Instead of typing a slash command,
describe your intent naturally:

```
Scaffold me a new Rust project at /tmp/my-rust-project
```

OpenCode will call the `pipeline` tool with `name="scaffold-rust"` and
`workspace="/tmp/my-rust-project"` and report the result.

The tool accepts all five pipeline names (`scaffold-rust`, `scaffold-cpp`,
`dev-cycle`, `rust-dev-cycle`, `cmake-dev-cycle`) and an optional `input`
argument for dev-cycle pipelines.

### Using a file as pipeline input

Instead of typing a request inline, you can point the pipeline at a file
containing the plan or instructions. Three approaches work today -- no code
changes required.

**1. `@` file reference (simplest)**

OpenCode automatically injects the contents of any `@`-referenced file into
the prompt. Works in both slash commands and conversational messages:

```
/pipeline scaffold-rust /tmp/my-project --input "@docs/my-plan.md"
```

```
Scaffold a Rust project at /tmp/my-project, using the plan described in @docs/my-plan.md
```

**2. Shell substitution in a slash command**

Use the `!`command`` syntax to inject file contents at invocation time, before
the LLM sees the prompt:

```
/pipeline scaffold-rust /tmp/my-project --input "!`cat docs/my-plan.md`"
```

**3. Conversational -- ask the LLM to read first (most natural)**

Just describe intent. OpenCode's built-in `read` tool handles the file, and the
LLM passes the content to the `pipeline` tool automatically:

```
Read the instructions in docs/scaffold-plan.md and scaffold a Rust project
at /tmp/my-project following those instructions.
```

> **Which to use:** Option 3 is the most natural for general use. Options 1 and
> 2 give more direct control over exactly what text reaches the `--input` flag.

---

## Skills

OpenCode agents use the `skill-retrieval` tool to load curated instructions
from SKILL.md files. Skills are auto-selected based on the task type
(action) and project language (workspace type).

| Category | Skills |
|----------|--------|
| Task skills | `programmer`, `debugger`, `architect`, `explorer`, `analyst`, `reviewer`, `tester` |
| Language skills | `rust`, `cpp` |
| Utility skills | `context-audit` |

Task and language skills are auto-injected for matching sessions. Utility skills
are loaded on demand when the agent recognises the user's intent.

See [`docs/skills.md`](docs/skills.md) for the full architecture, routing
tables, and API reference. See [`docs/context-audit.md`](docs/context-audit.md)
for the context audit skill reference.

---

## Development

```bash
# Install dependencies
bun install

# Type-check
bun run typecheck

# Lint and format
bunx biome check --write .

# Run tests with coverage
bun test --coverage
```

Target: ≥ 90% coverage. All three checks must pass before merging.
