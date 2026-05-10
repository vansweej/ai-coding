# @ai-coding/embeddings

Shared embedding abstraction used by `@ai-coding/skills` and `@ai-coding/codebase`.

## API

### `Embedder` interface

```typescript
interface Embedder {
  /** Embed a single string. */
  embed(text: string): Promise<EmbeddingResult>;
  /** Embed multiple strings in one forward pass (more efficient). */
  embedBatch(texts: readonly string[]): Promise<readonly EmbeddingResult[]>;
  /** Resolves to the vector dimension of this model. Cached after first call. */
  readonly dimensions: Promise<number>;
}

interface EmbeddingResult {
  readonly vector: Float32Array;
}
```

### `OllamaEmbedder`

Calls a local Ollama instance via `POST /api/embed`.

```typescript
import { OllamaEmbedder } from "@ai-coding/embeddings";

// Defaults: model="nomic-embed-text", baseUrl="http://localhost:11434"
const embedder = new OllamaEmbedder();

const { vector } = await embedder.embed("hash-based staleness check");
console.log(vector.length); // 768 (nomic-embed-text)

const results = await embedder.embedBatch(["foo", "bar", "baz"]);
```

### `isOllamaReachable`

Quick health-check — does not throw.

```typescript
import { isOllamaReachable } from "@ai-coding/embeddings";

if (!(await isOllamaReachable())) {
  console.error("Ollama is not running. Start with: ollama serve");
}
```

## Prerequisites

```bash
# Install and start Ollama
ollama serve

# Pull the embedding model
ollama pull nomic-embed-text
```

`nomic-embed-text` produces 768-dimensional vectors and runs entirely locally
with no API key required.
