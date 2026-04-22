# Rust Pipeline

## Overview

The Rust dev-cycle pipeline runs a complete development workflow on a Rust
project: planning and implementation via Claude Sonnet (GitHub Copilot), writing
the generated code to disk, then a full verification chain ending with a coverage gate.

All shell steps are nix-aware -- if a `flake.nix` is detected in the workspace,
every `cargo` command is automatically wrapped in `nix develop --command`.

---

## Pipeline Flow

```mermaid
flowchart LR
    subgraph LLM["LLM Steps (via Orchestrator)"]
        Plan["1. plan\nclaude-sonnet-4.6"]
        Impl["2. implement\nclaude-sonnet-4.6"]
        Write["3. write-files\nparse + write to disk"]
    end

    subgraph Verify["Verification Steps (NixShellStep)"]
        Fmt["4. fmt\ncargo fmt --check"]
        Clippy["5. clippy\ncargo clippy -D warnings"]
        Test["6. test\ncargo test"]
        Tarp["7. tarpaulin\ncargo tarpaulin"]
        Cov["8. coverage\ngate ≥ 90%"]
    end

    Plan --> Impl --> Write --> Fmt --> Clippy --> Test --> Tarp --> Cov

    style Plan fill:#1d6fa5,color:#fff
    style Impl fill:#1d6fa5,color:#fff
    style Write fill:#1d6fa5,color:#fff
    style Fmt fill:#b07d00,color:#fff
    style Clippy fill:#b07d00,color:#fff
    style Test fill:#2d6a4f,color:#fff
    style Tarp fill:#2d6a4f,color:#fff
    style Cov fill:#9b2226,color:#fff
```

---

## Data Flow Between Steps

```mermaid
flowchart TD
    Event["AIRequestEvent\npayload.input = user request"]

    Event -->|"original prompt"| Plan
    Plan["1. plan\noutput: architecture + approach"]

    Plan -->|"plan output"| Impl
    Event -->|"original request"| Impl
    Impl["2. implement\noutput: fenced code blocks with file paths"]

    Impl -->|"fenced code blocks"| Write
    Write["3. write-files\nparses blocks and writes .rs files to workspace"]

    Write -->|"source files on disk"| Fmt
    Fmt["4. fmt --check\nfails on formatting violations"]

    Fmt -->|"pass"| Clippy
    Clippy["5. clippy -- -D warnings\nfails on any lint warning"]

    Clippy -->|"pass"| Test
    Test["6. cargo test\nfails on any test failure"]

    Test -->|"pass"| Tarp
    Tarp["7. cargo tarpaulin\noutput: coverage text report"]

    Tarp -->|"coverage report text"| Cov
    Cov["8. coverage gate\nparsed % >= threshold"]

    Cov -->|"pass"| Done(["PipelineOutcome"])
```

---

## Step-by-Step Explanation

### Step 1: plan (OrchestratorStep, action: "plan")

Sends the user's original request to `claude-sonnet-4.6` via the Copilot API.
Produces a high-level implementation plan that step 2 will use.

**Model:** `claude-sonnet-4.6` (GitHub Copilot, `copilot-default` profile, `planner` role)
**Input:** `event.payload.input` (user's original request)
**Output:** Implementation plan text stored in `ctx.results.get("plan")`

### Step 2: implement (OrchestratorStep, action: "edit")

Combines the plan from step 1 with the original request into a structured
prompt. The model must respond with fenced code blocks that include file paths:

```typescript
(ctx) => {
  const plan = ctx.results.get("plan")?.output ?? "";
  const original = ctx.event.payload.input ?? "";
  return `Implement the following plan in Rust. Output ONLY fenced code blocks with file paths.\n\nPlan:\n${plan}\n\nOriginal request: ${original}`;
}
```

**Model:** `claude-sonnet-4.6` (GitHub Copilot, `copilot-default` profile, `implementer` role)
**Input:** plan + original request (composed by buildPrompt)
**Output:** Fenced code blocks with format ` ```rust <relative-path> `

### Step 3: write-files (FileWriterStep)

Parses the fenced code blocks from the `implement` output and writes each block
to the corresponding file path relative to the workspace directory. This is what
actually applies the generated code to disk.

**Reads from:** `ctx.results.get("implement")`
**Writes to:** `<workspace>/<relative-path>` for each code block

### Step 4: fmt (NixShellStep)

Runs `cargo fmt --check`. Fails the pipeline if any file would be reformatted.
This catches formatting issues before the slower test steps run.

**Command:** `cargo fmt --check`
**Failure:** Any file has formatting violations

### Step 5: clippy (NixShellStep)

Runs `cargo clippy -- -D warnings`. The `-D warnings` flag treats every
clippy warning as a hard error. Fails before tests if there are any lint issues.

**Command:** `cargo clippy -- -D warnings`
**Failure:** Any clippy warning or error

### Step 6: test (NixShellStep)

Runs the full test suite. Fails if any test fails.

**Command:** `cargo test`
**Failure:** Any test failure or compilation error

### Step 7: tarpaulin (NixShellStep, failOnNonZero: false)

Runs `cargo tarpaulin` to generate a coverage report. `failOnNonZero` is
set to `false` because tarpaulin can exit non-zero even when tests pass (e.g.
on some compiler warnings or partial environments). The actual pass/fail
decision is delegated to the coverage gate step.

**Command:** `cargo tarpaulin`
**Output:** Coverage text: `87.50% coverage, 35/40 lines covered`

### Step 8: coverage (CoverageGateStep)

Reads the tarpaulin output, extracts the percentage using the default regex
(`/(\d+\.?\d*)% coverage/i`), and fails if below the threshold.

**Reads from:** `ctx.results.get("tarpaulin")`
**Default threshold:** 90%
**Failure message:** `Coverage gate "coverage": 87.50% is below threshold 90%`

---

## Prerequisites

- `cargo` on PATH (or in a nix dev shell)
- `cargo-tarpaulin` installed: `cargo install cargo-tarpaulin`
- `cargo-clippy` (ships with rustup toolchains by default)
- The project must compile successfully before running the pipeline
- GitHub Copilot token available (via `opencode auth login` or `COPILOT_TOKEN` env)

---

## Invocation Example

```typescript
import { runPipeline } from "@ai-coding/pipeline";
import { CopilotDispatcher } from "ai-system/core/orchestrator/copilot-dispatcher";
import { COPILOT_DEFAULT_PROFILE } from "ai-system/config/model-profiles";
import type { OrchestratorConfig } from "ai-system/core/orchestrator/orchestrate";
import { createRustDevCyclePipeline } from
  "ai-system/core/pipeline/definitions/rust-dev-cycle";
import type { AIRequestEvent } from "@ai-coding/shared";

const config: OrchestratorConfig = {
  profile: COPILOT_DEFAULT_PROFILE,
  dispatchers: {
    "claude-sonnet-4.6": new CopilotDispatcher(process.env.COPILOT_TOKEN ?? ""),
  },
};

const event: AIRequestEvent = {
  id: crypto.randomUUID(),
  timestamp: Date.now(),
  source: "cli",
  action: "plan",
  payload: {
    input: "Add retry logic with exponential backoff to the HTTP client",
    workspace: "/home/user/my-rust-project",
  },
};

// Default coverage threshold: 90%
const steps = createRustDevCyclePipeline(config, "/home/user/my-rust-project");

// Custom coverage threshold:
// const steps = createRustDevCyclePipeline(config, "/home/user/my-rust-project", 85);

const result = await runPipeline(steps, event);

if (!result.ok) {
  console.error("Pipeline failed:", result.error.message);
  process.exit(1);
}

console.log(`All ${result.value.steps.length} steps passed in ${result.value.totalDurationMs}ms`);
```

Or use the CLI directly:

```bash
bun run pipeline rust-dev-cycle /home/user/my-rust-project \
  --input "Add retry logic with exponential backoff to the HTTP client"
```

---

## Customization

### Change the coverage threshold

```typescript
const steps = createRustDevCyclePipeline(config, workspace, 85); // allow 85%
```

### Skip fmt or clippy

Create a custom pipeline definition that omits those steps. Copy
`rust-dev-cycle.ts` and remove the steps you don't need.

### Add additional steps

Import and use `createNixShellStep` from `@ai-coding/pipeline`:

```typescript
import { createNixShellStep } from "@ai-coding/pipeline";

createNixShellStep<AIRequestEvent>("audit", ["cargo", "audit"], { cwd: workspace });
```
