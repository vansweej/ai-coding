# ai-coding

A TypeScript monorepo for an AI coding OS that routes requests to different LLM models based on
task type and runs multi-step agent pipelines for planning, implementing, and verifying code.

## Architecture

- **Model routing** -- `plan` actions go to `claude-sonnet` (Copilot), `debug` to
  `deepseek-coder-v2` (Ollama), everything else to `qwen3:8b` (Ollama)
- **Pipelines** -- linear step runners that chain LLM calls with shell commands (fmt, clippy,
  cmake, tarpaulin, etc.)
- **Scaffold pipelines** -- generate new Rust and C++ projects including a `flake.nix` dev shell

---

## Configuration

### Copilot token (required for plan steps)

All dev-cycle and scaffold pipelines include a `plan` step that calls `claude-sonnet` via the
GitHub Copilot API. This requires a bearer token.

The token is resolved in this order -- the first match wins:

**1. Environment variable `COPILOT_TOKEN`**

```bash
export COPILOT_TOKEN=your_token_here
bun run pipeline scaffold-rust /tmp/my-project
```

**2. Environment variable `GITHUB_COPILOT_TOKEN`**

```bash
export GITHUB_COPILOT_TOKEN=your_token_here
bun run pipeline scaffold-rust /tmp/my-project
```

**3. Config file `~/.config/ai-coding/config.json`**

```bash
mkdir -p ~/.config/ai-coding
```

```json
{
  "token": "your_token_here"
}
```

If no token is found, the CLI exits with:

```
Error: No Copilot token found. Set COPILOT_TOKEN or GITHUB_COPILOT_TOKEN,
or add { "token": "..." } to ~/.config/ai-coding/config.json
```

> Pipelines that consist entirely of local Ollama steps and no `plan` step do not require
> a Copilot token. Currently all built-in pipelines include a `plan` step, so the token is
> always needed in practice.

---

### Ollama URL (optional)

Local models are served via [Ollama](https://ollama.com) at `http://localhost:11434` by default.

Override the URL with the `OLLAMA_URL` environment variable:

```bash
export OLLAMA_URL=http://my-ollama-host:11434
```

---

### Monorepo path (required for global OpenCode integration)

When invoking pipelines from a different project directory via OpenCode's slash
commands or the custom tool, the pipeline CLI needs to know where the
`ai-coding` monorepo lives.

Set `AI_CODING_MONOREPO` to the absolute path of this repo:

```bash
export AI_CODING_MONOREPO=/home/vansweej/Projects/ai-coding
```

If you use **Home Manager**, this is set globally in `home.nix`
`home.sessionVariables` and is available in all sessions automatically. See
`~/Projects/home-manager/home.nix` for details.

If the variable is not set, the slash commands will silently fail and the
custom tool will return an explicit error message.

---

## Running pipelines

```bash
bun run pipeline <name> <workspace> [--input "request text"]
```

| Pipeline name    | Steps                                                  | Language   |
|------------------|--------------------------------------------------------|------------|
| `scaffold-rust`  | cargo init → generate flake.nix → write files          | Rust       |
| `scaffold-cpp`   | generate files → write files → cmake configure         | C++        |
| `dev-cycle`      | plan → implement → bun test                            | TypeScript |
| `rust-dev-cycle` | plan → implement → fmt → clippy → test → coverage gate | Rust       |
| `cmake-dev-cycle`| plan → implement → configure → build → ctest           | C++        |

### Examples

```bash
# Scaffold a new Rust project
mkdir /tmp/my-rust-project
bun run pipeline scaffold-rust /tmp/my-rust-project

# Scaffold a new C++ project
mkdir /tmp/my-cpp-project
bun run pipeline scaffold-cpp /tmp/my-cpp-project

# Run the TypeScript dev cycle with a specific request
bun run pipeline dev-cycle ./my-project --input "Add error handling to the parser"

# Run the Rust dev cycle
bun run pipeline rust-dev-cycle ./my-rust-project --input "Add a config module"
```

All shell steps are nix-aware: if a `flake.nix` is detected in the workspace, commands are
wrapped in `nix develop --command`.

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

Command files live in `.opencode/commands/`. Add new ones there to expose
additional pipelines as slash commands.

---

### Custom tool (conversational)

A custom tool registered at `.opencode/tools/pipeline.ts` lets the LLM call
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
