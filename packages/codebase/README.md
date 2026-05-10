# @ai-coding/codebase

Codebase RAG indexer — indexes git repositories into LanceDB using
tree-sitter WASM chunking and Ollama embeddings.

See [`docs/codebase-indexer.md`](../../docs/codebase-indexer.md) for the full
architecture reference, Mermaid diagrams, CLI flags, and language support guide.

## Quick Start

```bash
# Prerequisites
ollama serve
ollama pull nomic-embed-text

# Index a repository
bun run index-codebase /path/to/my-project

# Search the index
bun run codebase-retrieval "hash-based staleness check" --workspace /path/to/my-project
```

## Programmatic API

```typescript
import { CodebaseBackend, CodebaseStore, ParserPool } from "@ai-coding/codebase";
import { OllamaEmbedder } from "@ai-coding/embeddings";

const embedder = new OllamaEmbedder();
const store    = new CodebaseStore();
const pool     = new ParserPool();
const backend  = new CodebaseBackend(embedder, store, pool);

// Incremental refresh + vector search
const results = await backend.search("purge stale rows", "/path/to/repo");

for (const r of results) {
  console.log(`${r.filePath}:${r.startLine}-${r.endLine}  score=${r.score.toFixed(3)}`);
  console.log(r.text.slice(0, 200));
  console.log();
}
```

## Key Defaults

| Constant | Value | Override |
|----------|-------|----------|
| `DEFAULT_CODEBASE_DB_PATH` | `~/.local/share/ai-coding/codebase.lance` | `AI_CODING_CODEBASE_DB` |
| `DEFAULT_GRAMMARS_DIR` | `~/.local/share/ai-coding/grammars` | `AI_CODING_GRAMMARS_DIR` |
| `DEFAULT_TTL_DAYS` | `30` | `--ttl` flag / `IndexCodebaseOptions.ttlDays` |

## Supported Languages

TypeScript, JavaScript, Rust, C, C++, Python (tree-sitter WASM). Everything
else falls back to the heading-aware paragraph chunker.

## Adding a New Language

See `docs/codebase-indexer.md#adding-a-new-language` for the three-file checklist
(`detect-language.ts`, `node-extractors.ts`, home-manager Nix grammar).
