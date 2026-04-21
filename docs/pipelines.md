# Pipelines

## Overview

Pipelines coordinate multi-step agent workflows where the output of one step
feeds the input of the next. Each step is an independent unit of work -- an LLM
call, a shell command, or any custom operation -- and steps share a mutable
context bag so they can read each other's outputs.

The pipeline layer sits **above** the orchestrator. It does not replace the
existing routing logic; it calls into it. Every LLM step goes through the full
existing chain:

```
Pipeline runner
  └─ OrchestratorStep.execute()
       └─ orchestrate(event, config)
            ├─ resolveMode(source)       ← mode-router, unchanged
            ├─ selectModel(event, mode)  ← model-router, unchanged
            └─ dispatcher.dispatch()     ← OllamaDispatcher / CopilotDispatcher
```

The mode-router and model-router determine which model is used for each LLM
step automatically, based on the step's action and the event's source.

### Architecture diagram

```
┌────────────────────────────────────────────────────┐
│  Pipeline (run-pipeline.ts)                        │
│  Sequences steps, threads context, early exits     │
│                                                    │
│  ┌──────────┐   ┌─────────────┐   ┌─────────────┐ │
│  │  Step 1  │──▶│   Step 2    │──▶│   Step 3    │ │
│  │  plan    │   │  implement  │   │    test      │ │
│  └────┬─────┘   └──────┬──────┘   └──────┬──────┘ │
│       │                │                 │         │
│       ▼                ▼                 ▼         │
│  OrchestratorStep  OrchestratorStep  ShellStep     │
└────────────────────────────────────────────────────┘
         │                │
         ▼                ▼
  orchestrate()    orchestrate()      Bun.spawn()
  (existing)       (existing)         bun test
```

---

## Concepts

### PipelineStep

The unit of work. Every step implements this interface:

```typescript
interface PipelineStep {
  readonly name: string;
  execute(ctx: PipelineContext): Promise<Result<StepResult>>;
}
```

A step receives the shared context, performs its work, and returns either a
`StepResult` on success or an `Error` on failure. The step name must be unique
within a pipeline -- it is used as the key to store the result in context so
subsequent steps can read it.

### PipelineContext

The shared state threaded through every step in a pipeline run:

```typescript
interface PipelineContext {
  readonly event: AIRequestEvent;        // original request, unchanged throughout
  readonly results: Map<string, StepResult>;  // each step's output keyed by name
}
```

Steps read prior outputs via `ctx.results.get("step-name")?.output`. The
`results` map is populated in order, so a step can only read the outputs of
steps that ran before it.

### StepResult

The output a step produces on success:

```typescript
interface StepResult {
  readonly stepName: string;
  readonly output: string;
  readonly durationMs: number;
}
```

### PipelineOutcome

Returned by `runPipeline` when all steps succeed:

```typescript
interface PipelineOutcome {
  readonly steps: readonly StepResult[];
  readonly totalDurationMs: number;
}
```

### Early exit

If any step returns `{ ok: false, error }`, the pipeline stops immediately and
returns that error. Steps after the failing step are never executed.

---

## Built-in Step Types

### OrchestratorStep

`createOrchestratorStep` wraps the existing `orchestrate()` function. Use it
for any step that makes an LLM call.

```typescript
import { createOrchestratorStep } from
  "ai-system/core/pipeline/steps/orchestrator-step";

createOrchestratorStep(
  name: string,           // unique step name
  action: AIAction,       // "plan" | "edit" | "debug" | "refactor" | ...
  config: OrchestratorConfig,
  buildPrompt?: (ctx: PipelineContext) => string,
)
```

**How model routing works through it:**

The step builds a modified `AIRequestEvent` -- overriding the `action` field and
the `payload.input` -- then passes it to `orchestrate()`. The orchestrator calls
`resolveMode` and `selectModel` as usual:

| action  | source (from event) | Resolved mode | Model selected       |
|---------|---------------------|---------------|----------------------|
| `plan`  | `cli` / `agent`     | agentic       | `claude-sonnet`      |
| `debug` | `cli` / `agent`     | agentic       | `deepseek-coder-v2`  |
| `edit`  | `cli` / `agent`     | agentic       | `qwen2.5-coder:7b`   |
| any     | `nvim`              | editor        | `qwen2.5-coder:7b`   |

**The `buildPrompt` callback:**

When provided, `buildPrompt` is called with the current context before the
dispatch. Use it to compose a prompt from prior step outputs:

```typescript
createOrchestratorStep("implement", "edit", config, (ctx) => {
  const plan = ctx.results.get("plan")?.output ?? "";
  return `Implement this plan:\n\n${plan}`;
});
```

When omitted, the step uses the original `event.payload.input` unchanged.

### ShellStep

`createShellStep` runs an arbitrary shell command using `Bun.spawn`. Use it for
verification steps such as running tests or a type-checker.

```typescript
import { createShellStep } from
  "ai-system/core/pipeline/steps/shell-step";

createShellStep(
  name: string,
  command: readonly string[],   // command + args as an array, never a shell string
  options?: {
    cwd?: string;               // working directory (default: process cwd)
    timeoutMs?: number;         // kill after N ms (default: 60000)
    failOnNonZero?: boolean;    // treat non-zero exit as error (default: true)
  }
)
```

Commands are passed as an array and spawned directly -- there is no shell
interpolation, so there is no risk of injection. The step does not read or
write pipeline context; it runs the same fixed command on every invocation.

**On success:** returns `stdout` as the step output.

**On failure (non-zero exit, default):** returns an error containing the exit
code and any stderr output.

**On timeout:** kills the process and returns an error.

---

## Built-in Pipeline Definitions

### dev-cycle (plan → implement → test)

The `createDevCyclePipeline` factory produces the three-step development
workflow:

```
Step 1: plan       OrchestratorStep  action "plan"  → claude-sonnet
Step 2: implement  OrchestratorStep  action "edit"  → qwen2.5-coder:7b
Step 3: test       ShellStep         bun test
```

**Step 1 — plan:** Sends the original user request to `claude-sonnet` (via
`selectModel` routing `action: "plan"` in agentic mode). Produces a
high-level implementation plan as its output.

**Step 2 — implement:** Reads the plan from `ctx.results.get("plan")?.output`
and combines it with the original request into a structured prompt for
`qwen2.5-coder:7b`. This is where the `buildPrompt` callback wires the context
between steps.

**Step 3 — test:** Runs `bun test` in the workspace directory. Fails the
pipeline if any tests fail, ensuring the implement step produced working code.

---

## How to Invoke a Pipeline

### 1. Construct the dispatcher config

The config maps model names to dispatcher instances. This is the same
`OrchestratorConfig` used by the orchestrator directly.

```typescript
import { CopilotDispatcher } from
  "ai-system/core/orchestrator/copilot-dispatcher";
import { OllamaDispatcher } from
  "ai-system/core/orchestrator/ollama-dispatcher";
import type { OrchestratorConfig } from
  "ai-system/core/orchestrator/orchestrate";

const config: OrchestratorConfig = {
  dispatchers: {
    "claude-sonnet":     new CopilotDispatcher(process.env.COPILOT_TOKEN ?? ""),
    "deepseek-coder-v2": new OllamaDispatcher(),
    "qwen2.5-coder:7b":  new OllamaDispatcher(),
  },
};
```

### 2. Build the pipeline steps

```typescript
import { createDevCyclePipeline } from
  "ai-system/core/pipeline/definitions/dev-cycle";

const steps = createDevCyclePipeline(config, "/path/to/your/workspace");
```

### 3. Create the originating event

The event carries the user's original request through the pipeline. The
`source` field determines the operating mode (`"nvim"` → editor,
everything else → agentic).

```typescript
import type { AIRequestEvent } from "@ai-coding/shared";

const event: AIRequestEvent = {
  id: crypto.randomUUID(),
  timestamp: Date.now(),
  source: "cli",
  action: "plan",          // the initial action; each step overrides this internally
  payload: {
    input: "Add a retry mechanism to the OllamaDispatcher",
    workspace: "/path/to/your/workspace",
  },
};
```

### 4. Run the pipeline

```typescript
import { runPipeline } from "ai-system/core/pipeline/run-pipeline";

const result = await runPipeline(steps, event);

if (!result.ok) {
  console.error("Pipeline failed:", result.error.message);
  process.exit(1);
}

console.log("All steps completed in", result.value.totalDurationMs, "ms");

for (const step of result.value.steps) {
  console.log(`\n--- ${step.stepName} (${step.durationMs}ms) ---`);
  console.log(step.output);
}
```

### Reading individual step outputs

Each step's output is available in `PipelineOutcome.steps` by index, and also
accessible during the run via `ctx.results.get("step-name")`.

```typescript
const planOutput  = result.value.steps[0].output;  // claude-sonnet's plan
const implOutput  = result.value.steps[1].output;  // qwen's implementation
const testOutput  = result.value.steps[2].output;  // bun test stdout
```

---

## How to Create a New Pipeline

A pipeline definition is a factory function that returns `readonly PipelineStep[]`.
Follow these steps to build one.

### Step 1 — Identify the steps and their types

Decide whether each step:
- Makes an LLM call → use `createOrchestratorStep`
- Runs a command → use `createShellStep`
- Has custom logic → implement `PipelineStep` directly (see below)

### Step 2 — Create the factory function in `definitions/`

Place your factory in
`ai-system/core/pipeline/definitions/your-pipeline-name.ts`. Use a named export
and annotate the return type explicitly.

```typescript
import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import type { PipelineStep } from "../pipeline-types";
import { createOrchestratorStep } from "../steps/orchestrator-step";
import { createShellStep } from "../steps/shell-step";

export function createYourPipeline(
  config: OrchestratorConfig,
  workspace?: string,
): readonly PipelineStep[] {
  return [
    // ... steps in order
  ];
}
```

### Step 3 — Compose steps and wire context

Use `buildPrompt` on `OrchestratorStep` to read prior outputs from context:

```typescript
createOrchestratorStep("step-b", "edit", config, (ctx) => {
  const prevOutput = ctx.results.get("step-a")?.output ?? "";
  return `Based on this analysis:\n\n${prevOutput}\n\nNow implement ...`;
}),
```

### Worked example: debug-fix-verify pipeline

A three-step pipeline that diagnoses a bug, applies a fix, and re-runs tests:

```typescript
// ai-system/core/pipeline/definitions/debug-fix-verify.ts

import type { OrchestratorConfig } from "../../orchestrator/orchestrate";
import type { PipelineStep } from "../pipeline-types";
import { createOrchestratorStep } from "../steps/orchestrator-step";
import { createShellStep } from "../steps/shell-step";

export function createDebugFixVerifyPipeline(
  config: OrchestratorConfig,
  workspace?: string,
): readonly PipelineStep[] {
  return [
    // Step 1: diagnose with deepseek-coder-v2 (action "debug" → model-router picks it)
    createOrchestratorStep("debug", "debug", config),

    // Step 2: apply fix with qwen2.5-coder:7b, informed by the diagnosis
    createOrchestratorStep("fix", "edit", config, (ctx) => {
      const diagnosis = ctx.results.get("debug")?.output ?? "";
      const original  = ctx.event.payload.input ?? "";
      return (
        `A debugging agent has diagnosed the following issue:\n\n${diagnosis}\n\n` +
        `Apply a fix to resolve it. Original report: ${original}`
      );
    }),

    // Step 3: verify the fix did not break anything
    createShellStep("verify", ["bun", "test"], { cwd: workspace }),
  ];
}
```

Invoke it exactly like the dev-cycle pipeline:

```typescript
const steps = createDebugFixVerifyPipeline(config, "/path/to/workspace");
const result = await runPipeline(steps, event);
```

---

## Creating Custom Step Types

When neither `OrchestratorStep` nor `ShellStep` fits your needs, implement the
`PipelineStep` interface directly.

```typescript
import type { Result } from "@ai-coding/shared";

import type { PipelineContext, PipelineStep, StepResult } from
  "ai-system/core/pipeline/pipeline-types";

export function createValidatorStep(
  name: string,
  validate: (ctx: PipelineContext) => boolean,
  errorMessage: string,
): PipelineStep {
  return {
    name,
    execute: async (ctx: PipelineContext): Promise<Result<StepResult>> => {
      const startedAt = Date.now();

      if (!validate(ctx)) {
        return { ok: false, error: new Error(errorMessage) };
      }

      return {
        ok: true,
        value: { stepName: name, output: "validation passed", durationMs: Date.now() - startedAt },
      };
    },
  };
}
```

Rules for custom steps:
- Return `{ ok: false, error }` to fail the pipeline at this step.
- Return `{ ok: true, value: StepResult }` to proceed.
- The `stepName` in `StepResult` must match the step's `name` property.
- Never throw -- wrap exceptions in a `Result` error instead.
- Steps are pure functions of context; avoid shared mutable state between step instances.
