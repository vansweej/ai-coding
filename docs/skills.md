# Skills Package (`@ai-coding/skills`)

## Overview

`@ai-coding/skills` is a shared retrieval abstraction that serves skill knowledge
to both custom pipelines and (in future phases) OpenCode's agent loop. It resolves
the right set of skill files for a given AI action and workspace context, merges
them into a single string, and injects the result into LLM system prompts.

**Problem it solves:** Skills — curated Markdown files with domain-specific
instructions — were previously only available to OpenCode via its built-in `skill`
tool. Custom pipelines used hardcoded, minimal system prompts with no access to
the same knowledge. This package bridges that gap.

**Design philosophy:** Consumers are blind to the backend. The same `resolveSkill`
call works whether the backend reads files from disk (Phase 1) or queries a vector
database (Phase 2). Swapping backends requires no changes to consumers.

---

## Architecture

### System Position

```mermaid
graph TD
    subgraph Pipelines["Pipeline Definitions (ai-system/core/pipeline/definitions/)"]
        DevCycle["createDevCyclePipeline"]
        RustCycle["createRustDevCyclePipeline"]
        CMakeCycle["createCMakeDevCyclePipeline"]
    end

    subgraph SkillsPkg["@ai-coding/skills (packages/skills/)"]
        ResolveSkill["resolveSkill()"]
        MergeSkills["mergeSkills()"]
        SkillMap["resolveSkillNames()"]
        DetectWS["detectWorkspaceType()"]
        FileBack["FileBackend"]
    end

    subgraph SkillFiles["~/.config/opencode/skill/ (Home Manager)"]
        Programmer["programmer/SKILL.md"]
        Debugger["debugger/SKILL.md"]
        Architect["architect/SKILL.md"]
        Rust["rust/SKILL.md"]
        Cpp["cpp/SKILL.md"]
        More["..."]
    end

    subgraph PipelineStep["ai-system/core/pipeline/steps/"]
        SkillStep["createSkillResolverStep"]
    end

    DevCycle --> SkillStep
    RustCycle --> SkillStep
    CMakeCycle --> SkillStep

    SkillStep --> ResolveSkill
    ResolveSkill --> FileBack
    FileBack --> SkillMap
    FileBack --> DetectWS
    FileBack --> SkillFiles

    ResolveSkill --> MergeSkills

    style SkillsPkg fill:#2d6a4f,color:#fff
    style SkillStep fill:#457b9d,color:#fff
```

### Package Dependency Graph

```mermaid
graph LR
    Shared["@ai-coding/shared\nAIAction · AIRequestEvent"]
    Skills["@ai-coding/skills\nresolveSkill · mergeSkills\nFileBackend · SkillBackend"]
    Pipeline["@ai-coding/pipeline\nrunPipeline · PipelineStep"]
    AISystem["ai-system/core/pipeline\nSkillResolverStep\ndev-cycle · rust-dev-cycle · cmake-dev-cycle"]

    Skills --> Shared
    AISystem --> Skills
    AISystem --> Pipeline
    AISystem --> Shared
    Pipeline -.->|"no dependency"| Shared
    Pipeline -.->|"no dependency"| Skills

    style Skills fill:#2d6a4f,color:#fff
    style Shared fill:#1d3557,color:#fff
    style Pipeline fill:#2d6a4f,color:#fff
    style AISystem fill:#457b9d,color:#fff
```

---

## Resolution Flow

### Full Sequence

```mermaid
sequenceDiagram
    participant Pipeline as SkillResolverStep
    participant Resolve as resolveSkill()
    participant Backend as FileBackend
    participant Detect as detectWorkspaceType()
    participant Map as resolveSkillNames()
    participant FS as Filesystem

    Pipeline->>Resolve: resolveSkill(context, backend)
    Resolve->>Backend: backend.resolve(context)
    Backend->>Detect: detectWorkspaceType(workspace)
    Detect->>FS: Bun.file("Cargo.toml").exists()
    FS-->>Detect: true
    Detect-->>Backend: "rust"
    Backend->>Map: resolveSkillNames("edit", "rust")
    Map-->>Backend: ["programmer", "rust"]
    loop For each skill name
        Backend->>FS: Bun.file("~/.config/opencode/skill/{name}/SKILL.md").exists()
        FS-->>Backend: exists
        Backend->>FS: Bun.file(...).text()
        FS-->>Backend: content string
    end
    Backend-->>Resolve: ResolvedSkill[]
    Resolve-->>Pipeline: ResolvedSkill[]
    Pipeline->>Pipeline: mergeSkills(skills)
    Pipeline-->>Pipeline: StepResult { output: merged string }
```

### Two-Dimensional Routing

Skill resolution uses two orthogonal dimensions that compose additively:

```mermaid
flowchart TD
    Context["RetrievalContext\n{ action, workspace? }"]

    Context --> ActionDim["Action dimension\nACTION_SKILLS[action]"]
    Context --> WSDim["Workspace dimension\ndetectWorkspaceType(workspace)\n→ WORKSPACE_SKILLS[type]"]

    ActionDim --> ActionSkills["'what to do' skills\ne.g. programmer, debugger, architect"]
    WSDim --> WSSkills["'how to do it here' skills\ne.g. rust, cpp"]

    ActionSkills --> Union["Union (action first, workspace last)"]
    WSSkills --> Union

    Union --> FileRead["Read SKILL.md for each name\n(skip missing files)"]
    FileRead --> Result["ResolvedSkill[]"]
```

**Ordering is intentional:** action skills (general method) appear before workspace
skills (domain specialization). The LLM reads "here is how to debug" before
"and specifically in Rust, do it this way."

---

## Skill Routing Tables

### Action → Skills

| Action | Skills resolved | Rationale |
|--------|----------------|-----------|
| `edit` | `programmer` | Code generation task |
| `refactor` | `programmer` | Code transformation task |
| `debug` | `debugger` | Diagnosis and fix task |
| `plan` | `architect` | High-level design task |
| `explore` | `explorer` | Codebase navigation task |
| `explain` | `analyst` | Analysis and explanation task |
| `task` | `programmer` | General coding task |
| `chat` | _(none)_ | Conversational — no skill needed |

### Workspace Type → Additional Skills

| Detected marker | Workspace type | Additional skills |
|-----------------|---------------|-------------------|
| `Cargo.toml` | `rust` | `rust` |
| `CMakeLists.txt` | `cpp` | `cpp` |
| `package.json` | `typescript` | _(none)_ |
| _(no marker)_ | `unknown` | _(none)_ |

### Examples

| Action | Workspace | Resolved skills (in order) |
|--------|-----------|---------------------------|
| `edit` | Rust project | `programmer`, `rust` |
| `debug` | C++ project | `debugger`, `cpp` |
| `plan` | TypeScript project | `architect` |
| `chat` | Rust project | `rust` |
| `explore` | Unknown | `explorer` |

---

## Pipeline Integration

### Pipeline with Skill Resolution

```mermaid
flowchart LR
    Skills["resolve-skills\n(SkillResolverStep)"]:::skill --> Plan["plan\n(OrchestratorStep)"]
    Plan --> Implement["implement\n(OrchestratorStep)\nsystem prompt enriched\nwith skill content"]
    Implement --> Write["write-files\n(FileWriterStep)"]
    Write --> Test["test\n(NixShellStep)"]

    classDef skill fill:#2d6a4f,color:#fff
```

### How Skill Content Flows Into the System Prompt

```mermaid
sequenceDiagram
    participant Runner as runPipeline()
    participant SkillStep as SkillResolverStep
    participant PlanStep as OrchestratorStep (plan)
    participant ImplStep as OrchestratorStep (implement)
    participant Dispatcher as CopilotDispatcher

    Runner->>SkillStep: execute(ctx)
    SkillStep-->>Runner: StepResult { output: "## Skill: programmer\n\n..." }
    Runner->>Runner: ctx.results.set("resolve-skills", ...)

    Runner->>PlanStep: execute(ctx)
    PlanStep-->>Runner: StepResult { output: "1. Add retry logic..." }
    Runner->>Runner: ctx.results.set("plan", ...)

    Runner->>ImplStep: execute(ctx)
    Note over ImplStep: buildLlmOptions(ctx) reads<br/>ctx.results.get("resolve-skills")<br/>and prepends to system prompt
    ImplStep->>Dispatcher: dispatch({ system: "## Skill: programmer\n\n...\n\n---\n\nYou are a coding assistant...", prompt: "..." })
    Dispatcher-->>ImplStep: LLM response
    ImplStep-->>Runner: StepResult { output: "```typescript..." }
```

---

## API Reference

### `resolveSkill(context, backend)`

The stable public API. Delegates to the backend; consumers are blind to the
implementation.

```typescript
import { resolveSkill, FileBackend } from "@ai-coding/skills";

const backend = new FileBackend();
const skills = await resolveSkill({ action: "edit", workspace: "/my/project" }, backend);
// → ResolvedSkill[]
```

### `mergeSkills(skills)`

Concatenates resolved skills into a single string for system prompt injection.
Each skill is wrapped with a Markdown header. Returns `""` for an empty array.

```typescript
import { mergeSkills } from "@ai-coding/skills";

const systemPrompt = mergeSkills(skills);
// → "## Skill: programmer\n\n...\n\n---\n\n## Skill: rust\n\n..."
```

### `FileBackend`

File-based backend. Reads `SKILL.md` files from a configurable root directory.
Skips missing files silently.

```typescript
import { FileBackend } from "@ai-coding/skills";

// Default: ~/.config/opencode/skill/
const backend = new FileBackend();

// Custom root (e.g. for testing):
const backend = new FileBackend("/path/to/skills");
```

### `createSkillResolverStep(name, backend)`

Pipeline step factory. Resolves skills from the event's action and workspace,
stores merged content as `StepResult.output`.

```typescript
import { createSkillResolverStep, FileBackend } from "...";

const step = createSkillResolverStep("resolve-skills", new FileBackend());
// Downstream steps: ctx.results.get("resolve-skills")?.output
```

---

## Types

```typescript
/** Narrow context for skill retrieval — evolved only when consumers need more. */
interface RetrievalContext {
  readonly action: AIAction;
  readonly workspace?: string;
}

/** A single resolved skill with its content and optional relevance score. */
interface ResolvedSkill {
  readonly name: string;
  readonly content: string;
  readonly relevance?: number; // populated by vector backend (Phase 2)
}

/** Pluggable backend interface — consumers are blind to the implementation. */
interface SkillBackend {
  resolve(context: RetrievalContext): Promise<readonly ResolvedSkill[]>;
}

/** Detected workspace project type from filesystem marker files. */
type WorkspaceType = "rust" | "cpp" | "typescript" | "unknown";
```

---

## Creating a Custom Backend

Implement `SkillBackend` to plug in any retrieval mechanism:

```typescript
import type { ResolvedSkill, RetrievalContext, SkillBackend } from "@ai-coding/skills";

export class MyCustomBackend implements SkillBackend {
  async resolve(context: RetrievalContext): Promise<readonly ResolvedSkill[]> {
    // Your retrieval logic here
    return [{ name: "my-skill", content: "..." }];
  }
}
```

The vector backend (Phase 2) will implement this interface using LanceDB and
Ollama embeddings. Swapping it in requires no changes to pipeline definitions
or the `SkillResolverStep`.

---

## Phase 2 Evolution

```mermaid
flowchart TD
    subgraph Phase1["Phase 1 (current)"]
        FB["FileBackend\nReads full SKILL.md files\nfrom ~/.config/opencode/skill/"]
    end

    subgraph Phase2["Phase 2 (planned)"]
        VB["VectorBackend\nChunks skills at ## headings\nEmbeds via Ollama (nomic-embed-text)\nQueries LanceDB by semantic similarity\nReturns top-k chunks with relevance scores"]
    end

    subgraph Phase3["Phase 3 (future)"]
        UB["UnifiedBackend\nSkill chunks + research corpus + session memory\nSingle semantic query across all sources"]
    end

    Consumer["resolveSkill(context, backend)"]
    Consumer --> FB
    Consumer --> VB
    Consumer --> UB

    FB -.->|"swap backend,\nno consumer changes"| VB
    VB -.->|"extend backend,\nno consumer changes"| UB
```

**Token efficiency improvement:** Phase 1 sends full skill files (same as current
OpenCode behaviour). Phase 2 sends only the matching chunks per LLM call — for a
500-line skill, this could reduce injected tokens by 80%+ per call.

---

## Phase 2 — Vector Backend (Implemented)

Phase 2 adds semantic retrieval via LanceDB + Ollama embeddings. All components
are in `packages/skills/src/`.

### New Modules

| Module | Purpose |
|--------|---------|
| `embeddings/embedder-types.ts` | `Embedder`, `EmbeddingResult` interfaces |
| `embeddings/ollama-embedder.ts` | `OllamaEmbedder` — calls `POST /api/embed` on local Ollama |
| `chunking/markdown-chunker.ts` | `chunkSkill()` — splits SKILL.md on H2 headings, paragraph-splits oversized sections |
| `store/lance-store.ts` | `LanceStore` — wraps LanceDB table (open, upsertSkill, search, deleteSkill) |
| `indexer/index-skills.ts` | `indexSkills()` — discovers skills, hashes for staleness, chunks + embeds + upserts |
| `indexer/cli.ts` | `bun run skill-index` CLI with `--force`, `--skill-root`, `--db-path`, `--model` |
| `backends/vector-backend.ts` | `VectorBackend` — embeds query, ANN search, token-budget pruning, groups by skill |
| `backends/create-backend.ts` | `createBestBackend()` — auto-selects VectorBackend or FileBackend |
| `cli/skill-retrieval-cli.ts` | `bun run skill-retrieval` CLI used by the OpenCode tool |

### Retrieval Flow (Vector Backend)

```mermaid
sequenceDiagram
    participant Step as SkillResolverStep
    participant VB as VectorBackend
    participant Emb as OllamaEmbedder
    participant Store as LanceStore (LanceDB)

    Step->>VB: resolve({ action, workspace, query })
    VB->>Emb: embed("edit refactor the parser")
    Emb-->>VB: Float32Array[768]
    VB->>Store: search(vector, limit=20)
    Store-->>VB: SkillSearchResult[] (ordered by distance)
    VB->>VB: prune to token budget (2000 tokens)
    VB->>VB: group chunks by skill_name
    VB-->>Step: ResolvedSkill[] with relevance scores
```

### Indexer Flow

```mermaid
flowchart TD
    CLI["bun run skill-index"] --> Discover["discoverSkills(skillRoot)"]
    Discover --> ForEach["For each skill"]
    ForEach --> Hash["sha256(SKILL.md)"]
    Hash --> Stale{"Hash changed\nor --force?"}
    Stale -->|No| Skip["skip (skipped[])"]
    Stale -->|Yes| Chunk["chunkSkill()"]
    Chunk --> Embed["embedder.embedBatch(texts)"]
    Embed --> Upsert["store.upsertSkill()"]
    Upsert --> Indexed["indexed[]"]
    Indexed --> Meta["write .meta.json"]
    Skip --> Meta
```

### Backend Auto-Selection

```mermaid
flowchart TD
    Call["createBestBackend()"] --> Checks["isOllamaReachable() + lanceDbExists()"]
    Checks --> Both{"Both true?"}
    Both -->|Yes| Vector["VectorBackend\n(semantic retrieval)"]
    Both -->|No| File["FileBackend\n(static routing, always works)"]
```

### Key Design Decisions

- **Token budget**: default 2000 tokens (~8000 chars). Chunks are accumulated in
  distance order until the budget is exhausted. Oversized individual chunks are
  still emitted (never silently dropped).
- **Staleness detection**: SHA-256 of SKILL.md content, stored in `.meta.json`
  alongside the DB. Only changed skills are re-embedded on each index run.
- **Upsert strategy**: delete-by-filter + bulk add (simpler than `mergeInsert`,
  which requires all-or-nothing match/insert configuration).
- **LanceDB path**: `~/.local/share/ai-coding/skills.lance` (default), overridable
  via `AI_CODING_SKILLS_DB` env var.
- **Embedding model**: `nomic-embed-text` (768 dims) via Ollama. Overridable via
  `--model` CLI flag or `ollamaModel` option in `createBestBackend()`.
- **`query` field**: `RetrievalContext.query` (optional) carries the user's request
  text. The vector backend prepends it to the action label for richer embedding.
  The file backend ignores it.

### Getting Started

```bash
# 1. Start Ollama and pull the embedding model
ollama serve &
ollama pull nomic-embed-text

# 2. Index all skills (first time or after skill updates)
bun run skill-index

# 3. Force re-index everything
bun run skill-index --force

# 4. Pipelines now auto-use the vector backend when Ollama is running
bun run pipeline dev-cycle /path/to/workspace --input "add error handling"
```

---

## Open Questions (Deferred to Phase 3)

- Phase 3: ingest PDF/HTML research corpus alongside SKILL.md files.
- Phase 3: unified retrieval across skills + research corpus + session memory.
- Auto-discovery of new skills vs. manual `ACTION_SKILLS` map updates?
- Should `detectWorkspaceType()` cache results per workspace path?
