# Idea Brief: Shared Skills + Vector Context Layer

## Idea

A unified retrieval abstraction (`@ai-coding/skills`) that serves skill knowledge
and research context to both OpenCode's agent loop and custom pipelines, backed
by local LanceDB and Ollama embeddings.

## Context

The ai-coding project has two parallel LLM execution paths: OpenCode's built-in
agentic loop (used in daily build/plan sessions) and the custom pipeline system
(`ai-system/core/pipeline/`). Skills — curated markdown files with domain-specific
instructions — are today only available to OpenCode via its built-in `skill` tool.
Custom pipelines use hardcoded, minimal system prompts and have no access to the
same knowledge.

Two additional goals surfaced during brainstorming:
1. **Cross-session context preservation** — decisions, plans, and research insights
   are lost between OpenCode sessions; there is no persistent memory.
2. **Algorithmic research assistance** — the user wants AI to help design algorithms
   by synthesizing knowledge across multiple papers and techniques, leveraging the
   AI's ability to cross-cut concerns and merge ideas from different sources.

Token cost was an explicit driver: full-file skill loading wastes tokens; chunk-level
retrieval sends only what is relevant.

## Explored directions

1. **Static skill injection** — Read full `SKILL.md` files at pipeline construction
   time and prepend to `LLMOptions.system`. Simple, no new infrastructure, but
   doesn't solve token efficiency or research corpus needs.

2. **`@ai-coding/skills` shared package (file-backed)** — A `resolveSkill(action,
   context)` abstraction consumed by both pipelines and a custom OpenCode tool.
   Same resolution logic, same source of truth. Evolvable backend.

3. **Vector-backed retrieval + research corpus** — Skills and research papers stored
   in LanceDB, queried by semantic similarity before each LLM call. Enables partial
   skill retrieval and cross-paper synthesis. Highest capability, most infrastructure.

4. **Hybrid: file skills + vector memory** — Keep skill files as-is (OpenCode's
   built-in skill tool unchanged), add vector DB only for memory and research.
   Pragmatic but leaves skills and memory as disconnected systems.

## Chosen direction

**Direction 2 evolving into Direction 3** — start with the shared `@ai-coding/skills`
package (file-backed), then swap the backend for LanceDB retrieval without changing
consumers. This is the chosen direction because:

- It fixes the immediate problem (skills unavailable in pipelines) with minimal risk.
- The abstraction boundary (`resolveSkill`) makes the backend swap transparent.
- It sets up Phase 3 (research corpus + vector memory) without overbuilding Phase 1.
- The same `resolveSkill` call will eventually retrieve from skills, session memory,
  and research corpus in a single unified query.

## Key characteristics

**Unified retrieval interface:**
```typescript
resolveSkill(action: AIAction, context: RetrievalContext): Promise<string>
```
Returns relevant skill content (and later: research context) as a string ready for
injection into an LLM system prompt. Consumers are blind to whether the backend is
a file read or a vector query.

**Two separate LanceDB databases, one shared skill layer:**
- `personal-research/` — algorithms, CS theory papers, personal domain knowledge
- `work/` — company domain knowledge (different sensitivity, cloud-upgrade candidate)
- Skills are shared across both contexts — they are task instructions, not domain data

**Fully local stack:**
- Embeddings: Ollama (`nomic-embed-text` or equivalent) — zero cost, no data leaves
  the machine
- Vector store: LanceDB embedded — no server, Rust-based, zero infrastructure,
  TypeScript bindings, cloud upgrade path if company adopts it

**Heading-level chunking for skills:**
Skills are chunked at `##` heading boundaries. If sections prove too coarse, skill
files will be refactored with finer-grained headings — the chunking strategy drives
skill authoring discipline.

**PDF ingestion for research papers:**
Initial research ingestion path is PDF parsing → section chunking → embedding →
store in the appropriate database (personal or work). The AI can then be asked to
design algorithms with retrieval injecting relevant fragments from multiple papers,
enabling the cross-cutting synthesis that is hard for a human to do manually.

**Token efficiency:**
Phase 1 (file-based) sends whole skills — same as today's OpenCode behaviour.
Phase 2 (vector-backed) sends only the matching chunks per LLM call. For a 500-line
skill, this could reduce injected tokens by 80%+ per call. For a pipeline with 4
orchestrator steps, the savings compound.

## Open questions

- Which Ollama embedding model has the best quality/speed tradeoff for technical
  content (code, papers, algorithm descriptions)?
- Should the custom OpenCode `skill` tool replace the built-in one, or augment it
  (first try vector retrieval, fall back to built-in)?
- What is the right `RetrievalContext` shape — action only, or also workspace path,
  file types, active agent name?
- How should PDF chunking handle figures, equations, and code listings that don't
  map cleanly to markdown headings?
- Should the work database be provisioned separately (different path, different
  Ollama model for privacy) or just a different LanceDB table in the same process?
- What is the migration path if the company adopts LanceDB Cloud — is the API
  surface identical or does `resolveSkill` need to be aware?

## Prior art

- **LanceDB** — https://github.com/lancedb/lancedb — embedded vector DB, Rust core,
  TypeScript bindings, serverless, cloud upgrade path. Zero infrastructure.
- **Chroma** — https://github.com/chroma-core/chroma — Python-first, requires server,
  27.7k stars. Rejected: Python server conflicts with the Bun/TypeScript stack.
- **Mem0** — https://github.com/mem0ai/mem0 — LLM memory layer with auto-summarization.
  Noted for later: may inform the session memory design in Phase 3.
- **nomic-embed-text** — Ollama-available embedding model with strong performance on
  technical text. Primary candidate for local embeddings.

## Recommended next steps

**For `spar`:**
- Challenge whether the `resolveSkill` abstraction is the right boundary, or whether
  skills and research context should be two separate interfaces from the start.
- Push on the OpenCode integration: does replacing the built-in `skill` tool with a
  custom one risk breaking things, and is the benefit worth it in Phase 1?
- Question the heading-level chunking assumption — is it coarse enough to be
  semantically coherent, or will it produce noisy retrieval?

**For `plan`:**
- Phase 1: `@ai-coding/skills` package with file-based backend + `SkillResolverStep`
  for pipelines + custom OpenCode tool.
- Phase 2: LanceDB integration, Ollama embedding, skill chunking and indexing.
- Phase 3: Research corpus ingestion pipeline (PDF → chunk → embed → store), session
  memory, and unified retrieval across skills + research + memory.
- Define the `RetrievalContext` interface and `resolveSkill` contract before any
  backend is written — the interface is the commitment.
