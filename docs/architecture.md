# Architecture

## Overview

The AI Coding OS is a multi-layer system that routes coding requests to the
most appropriate LLM model. At the top is a **pipeline layer** that coordinates
multi-step agent workflows. Below that is the **AI layer** which handles a
single LLM call lifecycle. Both layers delegate to **dispatchers** that talk to
the actual model backends.

---

## Component Layering

```mermaid
graph TD
    subgraph Definitions["Pipeline Definitions (ai-system/core/pipeline/definitions/)"]
        Dev["createDevCyclePipeline\nparameterized by language config"]
        Lang["TYPESCRIPT_CONFIG · RUST_CONFIG · CPP_CONFIG\n(dev-cycle, interactive)"]
        PlanFactories["PLAN_CONFIG_FACTORIES\n8 languages: rust · typescript · python · cpp\nhaskell · julia · nix · shell\n(plan-cycle, unattended)"]
        Doc["doc-cycle sketch"]
    end

    subgraph PipelineSteps["Pipeline Steps (ai-system/core/pipeline/steps/)"]
        OrcStep["createOrchestratorStep"]
        SkillStep["createSkillResolverStep"]
        VerifyStep["createVerifiedImplementStep"]
    end

    subgraph SkillsPkg["@ai-coding/skills (packages/skills/)"]
        ResolveSkill["resolveSkill()"]
        MergeSkills["mergeSkills()"]
        FileBack["FileBackend"]
    end

    subgraph PipelinePkg["@ai-coding/pipeline (packages/pipeline/)"]
        Runner["runPipeline()"]
        ShellStep["createShellStep"]
        NixStep["createNixShellStep"]
        CoverageGate["createCoverageGateStep"]
    end

    subgraph AILayer["AI Layer (ai-system/core/)"]
        Orchestrator["orchestrate()"]
        ModeRouter["resolveMode()"]
        ModelRouter["selectModel()"]
    end

    subgraph Dispatchers["Dispatchers (ai-system/core/orchestrator/)"]
        Ollama["OllamaDispatcher\nlocalhost:11434"]
    end

    Dev --> Lang
    Dev --> Runner
    Doc --> Runner
    PlanFactories --> Runner

    Runner --> OrcStep
    Runner --> SkillStep
    Runner --> VerifyStep
    Runner --> ShellStep
    Runner --> NixStep
    Runner --> CoverageGate

    SkillStep --> ResolveSkill
    ResolveSkill --> FileBack

    OrcStep --> Orchestrator
    VerifyStep --> Orchestrator
    Orchestrator --> ModeRouter
    Orchestrator --> ModelRouter
    Orchestrator --> Ollama

    style SkillsPkg fill:#2d6a4f,color:#fff
    style SkillStep fill:#457b9d,color:#fff
```

---

## Package Dependency Graph

The `@ai-coding/pipeline` package has **zero dependency** on `@ai-coding/shared`
or any AI-specific types. It is a pure TypeScript library for sequencing steps
and threading context. The AI-specific coupling only appears in `ai-system/`,
which imports from both packages.

```mermaid
graph LR
    Shared["@ai-coding/shared\nAIRequestEvent · AIAction\nModelDispatcher · Result"]
    Embeddings["@ai-coding/embeddings\nEmbedder · EmbeddingResult\nOllamaEmbedder · isOllamaReachable"]
    Skills["@ai-coding/skills\nresolveSkill · mergeSkills\nFileBackend · VectorBackend\ncreateBestBackend · LanceStore\nchunkSkill"]
    Codebase["@ai-coding/codebase\nCodebaseBackend · indexCodebase\nCodebaseStore · ParserPool\nchunkFile · discoverFiles"]
    Pipeline["@ai-coding/pipeline\nrunPipeline · PipelineStep\nShellStep · NixShellStep\nCoverageGateStep"]
    AISystem["ai-system/core/pipeline\nOrchestratorStep · SkillResolverStep · VerifiedImplementStep\nplan-cycle (8 languages) · rust-plan-cycle alias · scaffold-rust · scaffold-cpp"]

    AISystem --> Pipeline
    AISystem --> Shared
    AISystem --> Skills
    Skills --> Shared
    Skills --> Embeddings
    Codebase --> Embeddings
    Pipeline -.->|"no dependency"| Shared
    Pipeline -.->|"no dependency"| Skills

    style Pipeline fill:#2d6a4f,color:#fff
    style Shared fill:#1d3557,color:#fff
    style Skills fill:#2d6a4f,color:#fff
    style Embeddings fill:#2d6a4f,color:#fff
    style Codebase fill:#457b9d,color:#fff
    style AISystem fill:#457b9d,color:#fff
```

---

## Full Request Flow

This sequence shows how a pipeline run flows from the caller all the way to a
model backend and back, for a pipeline that contains an `OrchestratorStep`
followed by a `NixShellStep`.

```mermaid
sequenceDiagram
    participant Caller
    participant Runner as runPipeline()
    participant OrcStep as OrchestratorStep
    participant Orch as orchestrate()
    participant Mode as resolveMode()
    participant Model as selectModel()
    participant Disp as Dispatcher (OllamaDispatcher)
    participant Nix as NixShellStep
    participant Shell as Bun.spawn

    Caller->>Runner: runPipeline(steps, event)

    Note over Runner: Validate: non-empty, no duplicate names

    Runner->>OrcStep: step.execute(ctx)
    OrcStep->>Orch: orchestrate(modifiedEvent, config)
    Orch->>Mode: resolveMode(source)
    Mode-->>Orch: AIMode ("agentic" | "editor")
    Orch->>Model: selectModel(event, mode)
    Model-->>Orch: model string (e.g. "claude-sonnet")
    Orch->>Disp: dispatch({ model, prompt, context })
    Disp-->>Orch: Result<string>
    Orch-->>OrcStep: Result<AIResponse>
    OrcStep-->>Runner: Result<StepResult>

    Runner->>Runner: store in ctx.results["step-name"]

    Runner->>Nix: step.execute(ctx)
    Nix->>Nix: check for flake.nix in cwd
    alt flake.nix present
        Nix->>Shell: Bun.spawn(["nix","develop","--command",...cmd])
    else no flake.nix
        Nix->>Shell: Bun.spawn(cmd)
    end
    Shell-->>Nix: stdout, stderr, exit code
    Nix-->>Runner: Result<StepResult>

    Runner-->>Caller: Result<PipelineOutcome>
```

---

## Directory Structure

```
ai-coding/
  packages/
    embeddings/                     Shared embedding abstraction (@ai-coding/embeddings)
      src/
        embedder-types.ts            Embedder, EmbeddingResult interfaces
        ollama-embedder.ts           OllamaEmbedder — POST /api/embed (nomic-embed-text)
        index.ts                     Barrel export
    pipeline/                       Generic pipeline infrastructure
      src/
        pipeline-types.ts            PipelineStep<T>, PipelineContext<T>, Result, StepResult
        run-pipeline.ts              Linear runner with early exit
        steps/
          shell-step.ts              Fixed command execution via Bun.spawn
          nix-shell-step.ts          Auto-detecting nix develop wrapper
          coverage-gate-step.ts      Parses coverage %, fails below threshold
        index.ts                     Barrel export
    skills/                         Shared skill retrieval abstraction
      src/
        skill-types.ts               RetrievalContext, ResolvedSkill, SkillBackend, WorkspaceType
        resolve-skill.ts             resolveSkill() — stable public API
        merge-skills.ts              mergeSkills() — concatenate for system prompt injection
        skill-map.ts                 ACTION_SKILLS, WORKSPACE_SKILLS, resolveSkillNames()
        detect-workspace-type.ts     Filesystem probe → WorkspaceType
        backends/
          file-backend.ts            Phase 1: reads SKILL.md files from disk
          vector-backend.ts          Phase 2: semantic ANN search via LanceDB
          create-backend.ts          createBestBackend() — auto-selects best available backend
        chunking/
          markdown-chunker.ts        chunkSkill() — H2-section splitting with paragraph overflow
        store/
          lance-store.ts             LanceStore — LanceDB open/upsert/search/delete wrapper
        indexer/
          index-skills.ts            indexSkills() — hash-based staleness, chunk+embed+upsert
          cli.ts                     bun run skill-index CLI
        cli/
          skill-retrieval-cli.ts     bun run skill-retrieval CLI (used by OpenCode tool)
        index.ts                     Barrel export
    codebase/                       Codebase RAG indexer (@ai-coding/codebase)
      src/
        chunk-types.ts               CodeChunk interface
        discovery/
          detect-language.ts         Extension → tree-sitter grammar name
          discover-files.ts          git ls-files walker; resolveFilePath helper
        chunking/
          parser-pool.ts             ParserPool — lazy WASM init + grammar caching
          node-extractors.ts         CHUNK_NODES map + extractChunks (AST walk)
          code-chunker.ts            chunkFile — tree-sitter or fallback dispatch
          fallback-chunker.ts        Heading-aware paragraph splitter
        store/
          codebase-store.ts          CodebaseStore — LanceDB codebase table wrapper
        indexer/
          index-codebase.ts          indexCodebase — hash-based incremental indexer
          purge.ts                   purgeStale · purgeDeadRepos · runPostIndexPurge
          cli.ts                     bun run index-codebase CLI
        backends/
          codebase-backend.ts        CodebaseBackend — search with query-time refresh
        cli/
          codebase-retrieval-cli.ts  bun run codebase-retrieval CLI
        index.ts                     Barrel export
  ai-system/
    shared/
      event-types.ts                 AIRequestEvent, AIAction, AIMode, Result (re-exported)
    core/
      mode-router/
        resolve-mode.ts              source → AIMode
      model-router/
        select-model.ts              (event, mode) → model string
      orchestrator/
        orchestrate.ts               Single LLM call lifecycle (profile-aware routing)
          ollama-dispatcher.ts         HTTP transport for local Ollama
          copilot-dispatcher.ts        HTTP transport for GitHub Copilot
          anthropic-dispatcher.ts      HTTP transport for native Anthropic Messages API
      pipeline/
        steps/
          orchestrator-step.ts       LLM step wrapping orchestrate()
          skill-resolver-step.ts     Skill resolution step (resolves + merges skills into context)
          verified-implement-step.ts implement → write files → verify → retry/escalate
        definitions/
          dev-cycle.ts               Unified [skills →] implement → write-files factory (Tier B: optional deletion)
          language-configs.ts        DevCycleLanguageConfig + PLAN_CONFIG_FACTORIES (8-language registry:
                                       rust, typescript, python, cpp, haskell, julia, nix, shell)
          doc-cycle.ts               Deferred documentation pipeline sketch
        plan-parser.ts               Structured markdown plan parser (Feature/Phase/Step + per-phase
                                       Coverage:/Language: directives)
        phase-runner.ts              Per-phase language resolution, baseline check, execution, auto-commit
        feature-runner.ts            Parses plan and runs phases sequentially
    config/
      model-profiles.ts              ModelRole, ModelProfile, copilot-default, hybrid, anthropic-sonnet, and bedrock-sonnet profiles
      pipeline-registry.ts           Single source of truth for pipeline metadata
  opencode/
    mappings/                        OpenCode provider/model configs
  docs/                              Documentation (you are here)
```

---

## Plan-Cycle: Plan File Format and Language Registry

`plan-cycle` (with `rust-plan-cycle` as a legacy alias forcing Rust) executes structured plan
files unattended, across 8 languages. Each phase may declare its own language and coverage
directive:

```markdown
# Feature: <name>

## Phase N: <title>

Commit message: <conventional commit>
Coverage: skip | N% | (omitted for default 90%, Rust only)
Language: rust | typescript | python | cpp | haskell | julia | nix | shell | (omitted to inherit default)

### Step N: <title>

<instruction>
```

Language resolution per phase: `phase.language ?? defaultLanguage` (from `--language`, or
`"rust"` when invoked as the `rust-plan-cycle` alias, or `"typescript"` as the final fallback).
A phase whose resolved language has no registered factory fails immediately with a clear error
rather than silently using the wrong toolchain.

### `PLAN_CONFIG_FACTORIES` registry

`ai-system/core/pipeline/definitions/language-configs.ts` exports a `PlanConfigFactory` type —
`(coverage, diff) => DevCycleLanguageConfig` — and a registry mapping all 8 `LanguageName` values
to their factory:

| Language | Toolchain | Coverage gate | `baselineCheck` |
|----------|-----------|:---:|:---:|
| `rust` | fmt → check → clippy → test → (if gated) tarpaulin → coverage | ✅ fatal when gated | — |
| `typescript` | typecheck → lint → test | — | — |
| `python` | format → lint → typecheck (warn-only) → test | — | — |
| `cpp` | configure → build → test | — | — |
| `haskell` | build (= typecheck) → lint → test | — | — |
| `julia` | test (weak — no separate format/lint) | — | — |
| `nix` | format → flake check | — | ✅ |
| `shell` | format → guarded shellcheck | — | ✅ |

`baselineCheck` languages (Nix, Shell) run their toolchain once on the untouched tree before any
implementation attempt, since their whole-repo validators (`nix flake check`, repo-wide
`shellcheck`) can't be scoped to a diff. A pre-existing failure there is a `BaselineCheckError`
(environment error, exit code 3), not a retryable phase failure.

See [`docs/plan-cycle.md`](plan-cycle.md) and
[`docs/plan-cycle-languages.md`](plan-cycle-languages.md) for the full user-facing guide and
per-language prerequisites.

---

## Skill System

OpenCode **skills** provide on-demand, language-specific guidance loaded only
when the agent is working in a relevant context. They complement the always-loaded
`AGENTS.md` files by keeping language rules out of the global config.

### Skill types

| Category | Skills | Loaded when |
|----------|--------|-------------|
| **Role skills** | `programmer`, `tester`, `reviewer`, `debugger`, `analyst`, `architect`, `documenter`, `explorer` | Agent recognises a role-specific task (implement, review, debug, document, etc.) |
| **Language skills** | `rust`, `cpp` | Agent recognises language-specific keywords (cargo, cmake, Cargo.toml, etc.) |

### Where skills live

All skills are deployed globally via Home Manager:

```
~/.config/opencode/skills/
  programmer/SKILL.md   — coding standards (language-agnostic)
  tester/SKILL.md       — testing conventions (language-agnostic)
  reviewer/SKILL.md     — review checklist (language-agnostic)
  debugger/SKILL.md     — debugging workflow (language-agnostic)
  rust/SKILL.md         — Rust-specific: cargo, clippy, tarpaulin, safety
  cpp/SKILL.md          — C++-specific: cmake, clang-format, clang-tidy, ctest
  ...
```

### Language skill dispatch

The role skills (programmer, tester, reviewer) delegate language-specific rules
to the language skills rather than duplicating them. Each role skill contains a
`## Language-Specific Rules` section that instructs the agent to load `rust` or
`cpp` when working in those languages.

### Project-local AGENTS.md

Scaffold pipelines (`scaffold-rust`, `scaffold-cpp`) write a lightweight
`AGENTS.md` into each new project containing:

- Project-specific build commands
- An explicit instruction to load the relevant language skill

This ensures the correct language skill is loaded even when trigger keywords
are not prominent in the conversation.

---

## Model Routing

Model selection uses the **role/profile** system. Each pipeline step declares a
semantic `ModelRole`; the active `ModelProfile` maps that role to a concrete model
ID and the dispatcher handles the HTTP transport.

### local profile (default)

All roles route to `gemma4:26b` via local Ollama:

| Role          | Model                | Backend       |
|---------------|----------------------|---------------|
| `planner`     | `gemma4:26b`         | Ollama        |
| `implementer` | `gemma4:26b`         | Ollama        |
| `debugger`    | `gemma4:26b`         | Ollama        |
| `fixer`       | `gemma4:26b`         | Ollama        |
| `reviewer`    | `gemma4:26b`         | Ollama        |
| `tester`      | `gemma4:26b`         | Ollama        |
| `scaffolder`  | `gemma4:26b`         | Ollama        |
| `explorer`    | `gemma4:26b`         | Ollama        |
| `default`     | `gemma4:26b`         | Ollama        |

### anthropic-sonnet profile

All roles route to `claude-sonnet-5` via the native Anthropic Messages API
(`https://api.anthropic.com/v1/messages`, authenticated with an `x-api-key` +
`anthropic-version` header pair rather than Copilot's `Authorization: Bearer`
scheme). Requires the `ANTHROPIC_API_KEY` environment variable.

| Role          | Model             | Backend                          |
|---------------|-------------------|-----------------------------------|
| `planner`     | `claude-sonnet-5` | Anthropic (native Messages API)  |
| `implementer` | `claude-sonnet-5` | Anthropic (native Messages API)  |
| `debugger`    | `claude-sonnet-5` | Anthropic (native Messages API)  |
| `fixer`       | `claude-sonnet-5` | Anthropic (native Messages API)  |
| `reviewer`    | `claude-sonnet-5` | Anthropic (native Messages API)  |
| `tester`      | `claude-sonnet-5` | Anthropic (native Messages API)  |
| `scaffolder`  | `claude-sonnet-5` | Anthropic (native Messages API)  |
| `explorer`    | `claude-sonnet-5` | Anthropic (native Messages API)  |
| `default`     | `claude-sonnet-5` | Anthropic (native Messages API)  |

The `plan-cycle` pipeline (and its `rust-plan-cycle` alias) parses its plan from a file rather
than generating it via an LLM, so the `planner` role never fires on that path —
only `implementer` (action `edit`) and `fixer` (action `fix`) roles actually
dispatch to Sonnet during a plan-cycle run.

### bedrock-sonnet profile

All roles route to a Claude Sonnet model hosted on **Amazon Bedrock** via the
`InvokeModel` API. Unlike the other three profiles, the model key
(`bedrock-sonnet`) is a stable *logical* token, not a real model ID: the
actual invoke target is a Bedrock **application inference profile ARN**,
resolved from the `AWS_BEDROCK_INFERENCE_PROFILE_ARN` environment variable at
`load-config.ts` time and injected into the `BedrockDispatcher` constructor.
This keeps the profile portable across AWS accounts — the ARN embeds an
account ID and must never be committed to source.

Authentication uses the AWS SDK's default credential provider chain (e.g. an
`aws sso login` session selected via `AWS_PROFILE`), not an API key. The
target region is parsed from the ARN itself, so `AWS_REGION` is optional.
The Bedrock client is configured with the SDK's standard retry strategy
(`maxAttempts`), which automatically retries `ThrottlingException` and
`ModelNotReadyException` with exponential backoff — important because a
shared, quota-limited inference profile can throttle mid-run, and
`plan-cycle`'s retry loop only retries *verification* failures, not
transport errors.

| Role          | Model             | Backend                                 |
|---------------|-------------------|-------------------------------------------|
| `planner`     | `bedrock-sonnet`  | Amazon Bedrock (InvokeModel API)        |
| `implementer` | `bedrock-sonnet`  | Amazon Bedrock (InvokeModel API)        |
| `debugger`    | `bedrock-sonnet`  | Amazon Bedrock (InvokeModel API)        |
| `fixer`       | `bedrock-sonnet`  | Amazon Bedrock (InvokeModel API)        |
| `reviewer`    | `bedrock-sonnet`  | Amazon Bedrock (InvokeModel API)        |
| `tester`      | `bedrock-sonnet`  | Amazon Bedrock (InvokeModel API)        |
| `scaffolder`  | `bedrock-sonnet`  | Amazon Bedrock (InvokeModel API)        |
| `explorer`    | `bedrock-sonnet`  | Amazon Bedrock (InvokeModel API)        |
| `default`     | `bedrock-sonnet`  | Amazon Bedrock (InvokeModel API)        |

Requires `AWS_BEDROCK_INFERENCE_PROFILE_ARN` plus valid AWS credentials
(`aws sso login` + `AWS_PROFILE`, or any other AWS SDK credential source).
SSO session credentials are time-bounded (commonly 1–8 hours); a long
unattended `plan-cycle` run should start right after a fresh login, since
expiry mid-run surfaces as a dispatch error (not retried by the backoff
above — it is not transient).

### Profile resolution

```
AIAction → actionToRole() → ModelRole → resolveModelForRole(role, profile) → model ID → dispatcher
```

The active profile is set in `OrchestratorConfig.profile`. The CLI resolves it via
`--profile <name>` flag, `AI_CODING_MODEL_PROFILE` env var, or the built-in default.

Provider selection is captured entirely in the profile: the `dispatchers` map
built by `load-config.ts` is provider-agnostic, binding each model-ID string to
its dispatcher (`claude-sonnet-5` → Anthropic, `claude-sonnet-4.6` → Copilot,
`gemma4:26b` → Ollama). There is no separate model-override flag; adding a new
provider mix is pure data — define another `ModelProfile` and register it.

### Legacy fallback

When no profile is set, the legacy `selectModel(event, mode)` heuristic is used
(preserved for backward compatibility). New code should always pass a profile.
