# Codebase RAG Indexer

## Goal

Index one or more git repositories into a local LanceDB vector store so that
OpenCode sessions can retrieve semantically relevant code chunks without
re-reading the entire codebase on every request. This reduces per-session token
costs and enables cross-repo search.

---

## Architecture Overview

The codebase indexer lives in `packages/codebase/` (`@ai-coding/codebase`) and
is composed of four cooperating layers:

```mermaid
graph TD
    subgraph Discovery
        DL["detectLanguage()"]
        DF["discoverFiles()"]
    end

    subgraph Chunking
        PP["ParserPool\n(web-tree-sitter WASM)"]
        NE["extractChunks()\n(AST node extractor)"]
        FC["fallbackChunk()\n(paragraph splitter)"]
        CF["chunkFile()"]
    end

    subgraph Indexer
        IC["indexCodebase()"]
        PG["runPostIndexPurge()"]
    end

    subgraph Store
        CS["CodebaseStore\n(LanceDB)"]
    end

    subgraph Retrieval
        CB["CodebaseBackend\n.search()"]
    end

    subgraph Embeddings["@ai-coding/embeddings"]
        OE["OllamaEmbedder\n(nomic-embed-text)"]
    end

    DF --> IC
    DL --> IC
    IC --> CF
    CF --> PP
    CF --> NE
    CF --> FC
    IC --> OE
    IC --> CS
    IC --> PG
    PG --> CS

    CB --> IC
    CB --> OE
    CB --> CS

    style Store fill:#1d3557,color:#fff
    style Embeddings fill:#2d6a4f,color:#fff
    style Retrieval fill:#457b9d,color:#fff
```

**Key design choices:**

- **WASM-only tree-sitter** (`web-tree-sitter`) — avoids Bun crash issues with
  native NAPI bindings (#17503, #30286, #23770).
- **Incremental re-indexing** — only files whose SHA-256 hash changed are
  re-embedded; unchanged files are skipped in < 1 ms.
- **Fallback chunker** — files with no installed grammar use a heading-aware
  paragraph splitter, so markdown, TOML, YAML, and other text files are still
  indexed.
- **Single LanceDB table** — all repos share the `codebase` table, keyed by
  `repo_id` (= absolute repo root path). Multi-repo global search is a single
  vector query.

---

## Indexing Flow

```mermaid
sequenceDiagram
    participant CLI as index-codebase CLI
    participant IC as indexCodebase()
    participant DF as discoverFiles()
    participant CF as chunkFile()
    participant OE as OllamaEmbedder
    participant CS as CodebaseStore
    participant PG as runPostIndexPurge()
    participant Meta as GlobalMeta JSON

    CLI->>IC: indexCodebase(embedder, store, pool, repoPath, opts)

    IC->>Meta: load meta.json (fileHashes per repo)
    IC->>DF: discoverFiles(repoPath)
    Note over DF: git ls-files --cached --others

    IC->>CS: store.open(dimensions)

    loop for each discovered file
        IC->>IC: sha256(content)
        alt hash unchanged and not --force
            IC->>IC: skip file
        else hash changed or new
            IC->>CF: chunkFile(pool, repoId, filePath, content, language)
            CF-->>IC: CodeChunk[]
            IC->>OE: embedder.embedBatch(chunk texts)
            OE-->>IC: EmbeddingResult[]
            IC->>CS: store.upsertFile(repoId, filePath, chunks, embeddings)
        end
    end

    loop for each file in previous meta but NOT in discovered
        IC->>CS: store.deleteFile(repoId, filePath)
    end

    IC->>PG: runPostIndexPurge(store, ttlDays)
    PG-->>IC: PurgeResult { staleBefore, deadRepos }

    IC->>Meta: write updated meta.json
    IC-->>CLI: IndexCodebaseResult
```

---

## Chunking Decision Tree

Each source file passes through `chunkFile()`, which routes to tree-sitter or
the fallback chunker depending on whether a grammar `.wasm` is installed.

```mermaid
flowchart TD
    A[Source file] --> B{detectLanguage\nextension → grammar name}
    B -->|null| FALL[fallbackChunk\nparagraph splitter]
    B -->|language| C{ParserPool\n.hasGrammar?}
    C -->|no grammar .wasm| FALL
    C -->|grammar present| D[pool.getParser\nload WASM lazy]
    D --> E[parser.parse\nsource → Tree]
    E --> F[extractChunks\nwalk AST children]
    F --> G{chunk text\n> 3000 chars?}
    G -->|yes| H[sub-split on blank lines\npreserve line attribution]
    G -->|no| I[emit CodeChunk]
    H --> I
    I --> J{zero chunks\nfrom AST?}
    J -->|yes| FALL
    J -->|no| OUT[CodeChunk array]
    FALL --> OUT

    style FALL fill:#c9184a,color:#fff
    style OUT fill:#2d6a4f,color:#fff
```

**Chunk context prefix** — every chunk is prefixed with a self-contained header
so retrieval results are useful without extra context:

```
# file: src/store/lance-store.ts | class: LanceStore

export class LanceStore { ... }
```

---

## LanceDB Store Schema

The `codebase` table has a fixed Arrow schema. It is created once and shared
across all indexed repos.

```mermaid
erDiagram
    CODEBASE_TABLE {
        FixedSizeList vector       "Embedding vector (Ollama dimensions)"
        string        text         "Chunk text with context prefix"
        string        repo_id      "Absolute repo root path (= repoPath)"
        string        file_path    "Path relative to repo root"
        string        symbol_name  "Function/class name or empty string"
        string        symbol_kind  "AST node type or empty string"
        int32         chunk_index  "0-based index within file"
        int32         start_line   "1-based start line in source"
        int32         end_line     "1-based end line (inclusive)"
        string        content_hash "djb2 hash for dedup"
        string        indexed_at   "ISO-8601 timestamp (used for TTL)"
    }
```

**Default path:** `~/.local/share/ai-coding/codebase.lance`

Override with `AI_CODING_CODEBASE_DB` environment variable.

**Upsert strategy:** `upsertFile()` deletes all existing rows for
`(repo_id, file_path)` and then bulk-inserts the new chunks. This is simpler
than `mergeInsert` and sufficient for per-file granularity.

---

## Query-Time Freshness

`CodebaseBackend.search()` supports two freshness modes, selectable per-call via
the `refresh` option.

```mermaid
sequenceDiagram
    participant Caller
    participant CB as CodebaseBackend
    participant IC as indexCodebase()
    participant OE as OllamaEmbedder
    participant CS as CodebaseStore

    Caller->>CB: search(query, repoPath, { refresh: true })

    Note over CB: refresh=true (default)
    CB->>IC: indexCodebase(embedder, store, pool, repoPath, { ttlDays: 3650 })
    Note over IC: Incremental — only changed files re-embedded
    IC-->>CB: IndexCodebaseResult

    CB->>OE: embedder.embed(query)
    OE-->>CB: EmbeddingResult { vector }

    CB->>CS: store.searchInRepo(vector, repoPath, limit)
    CS-->>CB: CodebaseSearchResult[]

    CB-->>Caller: CodebaseResult[] (score = 1 − distance)

    ---

    Caller->>CB: search(query, repoPath, { refresh: false })

    Note over CB: refresh=false — skip re-index
    CB->>CS: store.open() — throws if table missing
    CB->>OE: embedder.embed(query)
    OE-->>CB: EmbeddingResult { vector }
    CB->>CS: store.searchInRepo(vector, repoPath, limit)
    CS-->>CB: CodebaseSearchResult[]
    CB-->>Caller: CodebaseResult[]
```

**When to use `refresh: false`:**

- Large repos (poky-scale) where the nightly `index-codebase` run is the
  primary indexing mechanism.
- Performance-sensitive paths where < 1 ms freshness check overhead matters.
- From the `codebase-retrieval` CLI via the `--no-refresh` flag.

**Score:** `score = 1 − L2_distance`. Higher is more similar. Range is
`(−∞, 1]`; well-matched chunks score close to 1.

---

## Purge Pipeline

The post-index purge runs automatically after every `indexCodebase()` call.
It has two stages that together prevent unbounded store growth.

```mermaid
flowchart TD
    IC[indexCodebase completes] --> PG[runPostIndexPurge]

    PG --> TTL[purgeStale\ncutoff = now − ttlDays]
    TTL --> DEL1["store.purgeOlderThan\nDELETE WHERE indexed_at < cutoff"]

    PG --> DEAD[purgeDeadRepos\nlist all repo_ids]
    DEAD --> LOOP{for each repo_id}
    LOOP --> EXISTS{existsSync\nrepo root dir?}
    EXISTS -->|yes| KEEP[skip]
    EXISTS -->|no| DEL2["store.deleteRepo\nDELETE WHERE repo_id = ..."]
    DEL2 --> LOOP
    KEEP --> LOOP

    TTL --> RESULT["PurgeResult\n{ staleBefore, deadRepos }"]
    DEAD --> RESULT

    style DEL1 fill:#c9184a,color:#fff
    style DEL2 fill:#c9184a,color:#fff
    style RESULT fill:#2d6a4f,color:#fff
```

**Default TTL:** 30 days (`DEFAULT_TTL_DAYS`). Override per-call via
`IndexCodebaseOptions.ttlDays`.

**Note:** Query-time refresh uses `ttlDays: 3650` (≈10 years) so that freshly
indexed rows are never swept away immediately after indexing.

**Manual purge commands:**

```bash
# Via bun run (from ai-coding monorepo)
bun run index-codebase /path/to/repo --purge-only

# Via shell wrapper (from any directory)
index-codebase --purge-only

# Adjust TTL
index-codebase --ttl 7
```

---

## CLI Usage

### Index a repository

```bash
bun run index-codebase <repo-path> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--force` | off | Re-index all files, bypassing the hash check |
| `--purge-only` | off | Run only the purge step, no indexing |
| `--ttl <days>` | `30` | TTL for the post-index purge sweep |
| `--db-path <path>` | `~/.local/share/ai-coding/codebase.lance` | LanceDB path |
| `--model <name>` | `nomic-embed-text` | Ollama embedding model |
| `--grammars <dir>` | `~/.local/share/ai-coding/grammars` | Grammar `.wasm` directory |

```bash
# Index the current repo
bun run index-codebase .

# Force full re-index with a custom model
bun run index-codebase /path/to/my-project --force --model mxbai-embed-large

# Nightly cron (large repo, skip TTL purge of freshly indexed rows)
bun run index-codebase /path/to/poky --ttl 90
```

### Search the index

```bash
bun run codebase-retrieval <query> [options]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--workspace <path>` | — | Restrict results to this repo (also triggers refresh) |
| `--limit <n>` | `10` | Maximum number of results |
| `--no-refresh` | off | Skip incremental re-index before search |
| `--db-path <path>` | `~/.local/share/ai-coding/codebase.lance` | LanceDB path |
| `--model <name>` | `nomic-embed-text` | Ollama embedding model |
| `--grammars <dir>` | `~/.local/share/ai-coding/grammars` | Grammar `.wasm` directory |

```bash
# Search the current repo (auto-refresh)
bun run codebase-retrieval "hash-based staleness check" --workspace .

# Global search across all indexed repos
bun run codebase-retrieval "how does the purge step work"

# Fast query without re-index
bun run codebase-retrieval "LanceDB schema" --workspace . --no-refresh
```

---

## Shell Wrappers (run from any directory)

Home Manager deploys two bash wrapper scripts to `~/.local/bin/` so the
indexer and retrieval CLIs can be invoked from any repository directory
without `cd`-ing to the ai-coding monorepo first. Both wrappers use
`$AI_CODING_MONOREPO` (set globally by Home Manager) to locate the monorepo
and delegate to `bun run --cwd`.

### `index-codebase`

```bash
# Index the current directory (repo path defaults to $PWD)
index-codebase

# Index a specific repo
index-codebase /path/to/repo

# Force full re-index of current directory
index-codebase --force

# Custom TTL
index-codebase --ttl 7

# Purge only — no repo path needed
index-codebase --purge-only
```

All flags (`--force`, `--ttl`, `--db-path`, `--model`, `--grammars`) are
forwarded verbatim to the underlying CLI.

### `codebase-retrieval`

```bash
# Search the current repo (--workspace $PWD is injected automatically)
codebase-retrieval "hash-based staleness check"

# Search a specific repo
codebase-retrieval "purge pipeline" --workspace /path/to/repo

# Limit results
codebase-retrieval "LanceDB schema" --limit 5

# Fast query without incremental re-index
codebase-retrieval "LanceDB schema" --no-refresh
```

When `--workspace` is not provided, `$PWD` is injected automatically so
results are scoped to the repository you are currently working in. Pass
`--workspace` explicitly to search a different repo or to search globally
(omit `--workspace` entirely only when you want cross-repo results — but
note that the wrapper always injects `$PWD` unless you override it).

### Prerequisites

Scripts are deployed by running `home-manager switch` on any machine. After
the switch, open a new shell (so `~/.local/bin` is on `$PATH`) and verify:

```bash
which index-codebase       # → ~/.local/bin/index-codebase
which codebase-retrieval   # → ~/.local/bin/codebase-retrieval
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_CODING_CODEBASE_DB` | `~/.local/share/ai-coding/codebase.lance` | LanceDB store path |
| `AI_CODING_GRAMMARS_DIR` | `~/.local/share/ai-coding/grammars` | Tree-sitter `.wasm` grammar directory |

---

## Programmatic API

```typescript
import { CodebaseBackend, CodebaseStore, ParserPool } from "@ai-coding/codebase";
import { OllamaEmbedder } from "@ai-coding/embeddings";

const embedder = new OllamaEmbedder("nomic-embed-text");
const store    = new CodebaseStore();
const pool     = new ParserPool();
const backend  = new CodebaseBackend(embedder, store, pool);

// Search with automatic incremental refresh
const results = await backend.search("hash-based staleness", "/path/to/repo");
for (const r of results) {
  console.log(`${r.filePath}:${r.startLine}-${r.endLine} (score ${r.score.toFixed(3)})`);
  console.log(r.text.slice(0, 200));
}
```

---

## Language Support

| Language | Extensions | Status |
|----------|-----------|--------|
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | Deployed |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.jsx` | Deployed |
| Rust | `.rs` | Deployed |
| C | `.c`, `.h` | Deployed |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx` | Deployed |
| Python | `.py` | Deployed |
| Haskell | `.hs`, `.lhs` | Grammar not yet deployed |
| Lua | `.lua` | Grammar not yet deployed |
| Julia | `.jl` | Grammar not yet deployed |
| *Everything else* | — | Fallback paragraph chunker |

Grammar files are deployed by Home Manager to `~/.local/share/ai-coding/grammars/`
as `tree-sitter-<language>.wasm`. Run `home-manager switch` to deploy new grammars.

---

## Adding a New Language

1. **Extension mapping** — add to `EXT_TO_LANG` in
   `packages/codebase/src/discovery/detect-language.ts`:
   ```typescript
   ".go": "go",
   ```

2. **AST node types** — add to `CHUNK_NODES` in
   `packages/codebase/src/chunking/node-extractors.ts`:
   ```typescript
   go: [
     "function_declaration",
     "method_declaration",
     "type_declaration",
     "import_declaration",
   ],
   ```

3. **Grammar deployment** — add a `pkgs.fetchurl` entry in the home-manager
   Nix configuration (see `modules/grammars.nix` in the home-manager repo),
   pinned to a known SHA-256:
   ```nix
   "tree-sitter-go.wasm" = pkgs.fetchurl {
     url  = "https://github.com/nicolo-ribaudo/tree-sitter-go-wasm/releases/download/v0.1.0/tree-sitter-go.wasm";
     sha256 = "sha256-<hash>";
   };
   ```

4. **Deploy** — run `home-manager switch` to copy the `.wasm` file to
   `~/.local/share/ai-coding/grammars/tree-sitter-go.wasm`.

5. **Test** — write a test in `packages/codebase/src/chunking/node-extractors.test.ts`
   that parses a short Go snippet and asserts the expected chunks.

---

## Troubleshooting

### `Grammar not found for language "typescript": ...`

The `.wasm` grammar file is missing from `AI_CODING_GRAMMARS_DIR`.

```bash
# Check what grammars are deployed
ls ~/.local/share/ai-coding/grammars/

# Re-deploy via Home Manager
home-manager switch --flake ~/Projects/home-manager#<machine>
```

### `CodebaseStore not opened`

`refresh: false` was passed but no previous `index-codebase` run has created the
LanceDB table. Either run `bun run index-codebase <repo>` first, or drop the
`--no-refresh` flag.

### Ollama not running

```bash
# Start Ollama
ollama serve

# Pull the embedding model
ollama pull nomic-embed-text
```

### Index is stale after code changes

By default the `CodebaseBackend` runs an incremental re-index on every search
(`refresh: true`). If you are using `--no-refresh`, re-run:

```bash
bun run index-codebase <repo-path>
```

---

## References

- [`packages/codebase/README.md`](../packages/codebase/README.md) — package-level quick-start
- [`packages/embeddings/README.md`](../packages/embeddings/README.md) — embedder API reference
- [`docs/architecture.md`](./architecture.md) — full system component diagram
- [`docs/skills.md`](./skills.md) — skill retrieval system (parallel use-case)
