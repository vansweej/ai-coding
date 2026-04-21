# ai-coding

A TypeScript monorepo for an AI coding OS that routes requests to different LLM models based on
task type and runs multi-step agent pipelines for planning, implementing, and verifying code.

## Architecture

- **Model routing** -- `plan` actions go to `claude-sonnet` (Copilot), `debug` to
  `deepseek-coder-v2` (Ollama), everything else to `qwen2.5-coder:7b` (Ollama)
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
