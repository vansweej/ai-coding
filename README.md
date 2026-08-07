# ai-coding

A TypeScript monorepo for an AI coding OS that routes requests to different LLM models based on
task type and runs multi-step agent pipelines for planning, implementing, and verifying code.

## Architecture

- **Model profiles** -- named configurations mapping semantic roles (planner, implementer,
  debugger, fixer…) to model IDs. Default: `copilot-default` (all roles → GitHub Copilot's
  Claude Sonnet 5, internal id `copilot/claude-sonnet-5`). Other built-in profiles: `local` (all roles → `gemma4:26b` via local
  Ollama; no cloud dependencies or API tokens required), `hybrid` (mixes Copilot and Ollama per
  role), `anthropic-sonnet` (all roles → `claude-sonnet-5` via the native Anthropic Messages
  API; requires `ANTHROPIC_API_KEY`), `bedrock-sonnet` (all roles → Claude Sonnet on Amazon
  Bedrock via the InvokeModel API; requires `AWS_BEDROCK_INFERENCE_PROFILE_ARN` and AWS
  credentials resolved through the AWS SDK's default provider chain, e.g. `aws sso login` +
  `AWS_PROFILE`), and `opencode-free` (all roles → a free OpenCode Zen model via the
  OpenAI-compatible chat/completions endpoint; requires `OPENCODE_ZEN_API_KEY` and
  `OPENCODE_ZEN_MODEL`, e.g. `deepseek-v4-flash-free` -- swapping the free model when it
  rotates out is a one-line `OPENCODE_ZEN_MODEL` change).
- **Structured patch output** -- capable backends (currently Copilot's
  `copilot/claude-sonnet-5` / `claude-sonnet-4.6`, confirmed live; Anthropic's
  `claude-sonnet-5`, confirmed via dry run) emit **whole-phase structured
  patches** (typed create/edit/move ops via a forced tool call) instead of
  free-text SEARCH/REPLACE, applied transactionally with automatic rollback on
  partial failure. Every other model is unaffected and keeps using the
  existing aider-style text patch path, which also remains the automatic
  fallback if a structured attempt fails for any reason. See
  [`docs/architecture.md`](docs/architecture.md#structured-patch-output-contract)
  for the full design.
- **Pipelines** -- plan-file driven workflows that implement steps, write files, verify with the
  language toolchain, retry locally, escalate fixes when needed, and commit each successful phase.
  `plan-cycle` auto-routes each touched file to a toolchain (rust, typescript, python, cpp,
  haskell, julia, nix, shell) based on what's available in the workspace's devShell
  (`flake.nix`); files with no matching or available toolchain are edit-only.
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
bun run pipeline <name> <workspace> [--plan <file> | --input "request text"] [--max-retries <n>] [--profile <name>] [-v | --verbose]
```

| Pipeline name     | Steps                                                                  | Language(s)   |
|-------------------|-------------------------------------------------------------------------|---------------|
| `plan-cycle`      | unattended plan execution with memory tracking and resumable failures  | rust, typescript, python, cpp, haskell, julia, nix, shell (auto-routed per file from the workspace's devShell) |
| `scaffold-rust`   | cargo init → generate flake.nix → write files → write AGENTS.md         | Rust          |
| `scaffold-cpp`    | generate files → write files → cmake configure → write AGENTS.md       | C++           |

Each phase's toolchain is auto-detected per file from the workspace's devShell (`flake.nix`) —
there is no language selection flag or directive. A file with no available toolchain in the
devShell (e.g. no `cargo` present) or no matching toolchain at all (e.g. `.md`/`.json`) is
treated as edit-only. See [`docs/plan-cycle-languages.md`](docs/plan-cycle-languages.md) for the
full per-language toolchain reference and Nix flake dev-shell prerequisites.

`-v` / `--verbose` streams a live per-phase/step progress feed (start, finish, retry, failure) to
**stderr** while a plan-cycle run executes, using nerd-font glyphs and color on a TTY (plain ASCII
otherwise, and honoring `NO_COLOR`). Off by default — the normal end-of-run summary on stdout is
unchanged either way.

## Codebase indexer

Index a git repository for semantic code search:

```bash
# Via bun run (from the ai-coding monorepo directory)
bun run index-codebase <repo-path> [--force] [--ttl <days>] [--exclude <glob>]
bun run index-codebase --purge-repo <path>   # remove a specific repo (no Ollama needed)
bun run codebase-retrieval <query> [--workspace <path>] [--limit <n>] [--no-refresh]
```

Exclude files from vectorization with a root-level `.ai-coding-ignore` file
(gitignore syntax) — excluded files stay tracked in git and browsable, only
the vector index skips them. Exempt files from TTL purge with a root-level
`.ai-coding-keep` file. See
[`docs/codebase-indexer.md#ignore--keep-filters`](docs/codebase-indexer.md#ignore--keep-filters)
for full syntax and precedence rules.

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

# Run an unattended plan-cycle
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md

# Run a polyglot plan (each touched file is auto-routed to its own toolchain)
bun run pipeline plan-cycle ./my-project --plan ./plans/rate-limit.md

# Run on native Anthropic Claude Sonnet (native Messages API; recommended for larger multi-file phases)
ANTHROPIC_API_KEY=sk-ant-... bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md --profile anthropic-sonnet

# Run on Claude Sonnet via Amazon Bedrock (InvokeModel API; uses AWS SSO / credential chain)
aws sso login --profile my-company-profile
export AWS_PROFILE=my-company-profile
export AWS_BEDROCK_INFERENCE_PROFILE_ARN=arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/abc123
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md --profile bedrock-sonnet
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

## Unattended Plan Cycle (`plan-cycle`)

The `plan-cycle` pipeline executes multi-phase, **multi-language** plans **unattended** with
automatic repair, memory tracking, and resumable failures. It is designed for CI/CD workflows and
autonomous agent execution. Each phase's toolchain is auto-routed per touched file from the
workspace's devShell — there is no way to force a specific language.

### Key Features

- **Unattended execution**: Runs all phases without human intervention
- **Multi-language**: auto-routes each touched file to a toolchain (rust, typescript, python, cpp,
  haskell, julia, nix, shell) based on what's available in the workspace's devShell
  (`flake.nix`). Files with no matching or available toolchain (e.g. `.md`/`.json`) are
  edit-only.
- **Automatic repair**: Retries failed steps locally with diagnostics; escalates to the fixer
  role if needed
- **Memory tracking**: Stores phase context and completion status for resumability
- **Resumable failures**: Exit code 2 indicates a phase exhausted its repair budget but can be resumed
- **Branch enforcement**: Must run on a dedicated feature branch (not main/master/develop)
- **Fatal coverage gate**: Rust only — coverage threshold is enforced; failures block the phase
- **Baseline-green precondition**: Nix and Shell run their whole-repo validator (`nix flake check`,
  `shellcheck`) once on the untouched tree before any implementation attempt; a pre-existing
  failure is an environment error (exit 3), not a retryable phase failure
- **Verbose progress feed**: `-v` / `--verbose` streams phase/step start, finish, retry, and
  failure events to stderr as the run executes; silent by default

### Usage

```bash
# Run from a feature branch (required)
git checkout -b feat/my-feature

# Execute a plan (each touched file is auto-routed to its own toolchain)
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md

# Execute a Rust plan
bun run pipeline plan-cycle ./my-rust-project --plan ./plans/feature.md

# Execute with a live progress feed on stderr
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md --verbose

# Exit codes:
#   0 = all phases passed
#   2 = phase exhausted repair budget (resumable — run again to continue)
#   3 = input/environment error (bad plan, wrong branch, missing toolchain, baseline check failure)
```

### Plan File Format

Create a plan file with phases and steps. A `Coverage:` directive is optional per phase:

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
Coverage: 85%

### Step 1: Add unit tests

Add comprehensive unit tests to src/auth/mod.rs.
```

Each phase is committed separately with a `Phase: N` trailer for resume tracking.

### Resume Workflow

If a phase fails and exhausts its repair budget (exit code 2):

```bash
# Fix the issue manually or wait for the next retry
# Then resume from where it left off
bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md

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
| 3 | Input/environment error (incl. baseline check failure) | Fix the error and retry |

### Troubleshooting

**"Error: plan-cycle must run on a dedicated feature branch"**
- You are on main, master, or develop
- Create a feature branch: `git checkout -b feat/my-feature`

**"Phase N uses unregistered language"**
- The toolchain auto-routed from the workspace's devShell doesn't match a known toolchain
- See [`docs/plan-cycle-languages.md`](docs/plan-cycle-languages.md)

**"Baseline check failed... before any implementation attempt"**
- Nix or Shell phase — the whole-repo validator was already failing before this run started
- Fix the pre-existing issue directly, then re-run

**"Phase exhausted repair budget (exit code 2)"**
- The phase failed after local retries and fixer escalation
- Review the error message and fix the issue manually
- Run the pipeline again to resume from the next phase

**"Coverage gate failed"** (Rust only)
- Test coverage is below the threshold (default 90%)
- Add more tests or adjust the `Coverage:` directive in the plan file
- See [`docs/plan-cycle.md`](docs/plan-cycle.md) for coverage directives

See [`docs/plan-cycle.md`](docs/plan-cycle.md) for full documentation and
[`docs/plan-cycle-languages.md`](docs/plan-cycle-languages.md) for the per-language toolchain
reference and Nix flake dev-shell prerequisites.

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
/pipeline plan-cycle ./my-project --plan ./plans/feature.md
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

The tool accepts all registered pipeline names (`plan-cycle`,
`scaffold-rust`, `scaffold-cpp`) and an optional `input`/`plan` argument for
`plan-cycle` runs.

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
