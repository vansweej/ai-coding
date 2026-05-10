import type { Embedder, EmbeddingResult } from "./embedder-types";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
const DEFAULT_MODEL = "nomic-embed-text";

interface OllamaEmbedResponse {
  readonly embeddings: readonly number[][];
}

/**
 * Embedder that calls a local Ollama instance via the `/api/embed` endpoint.
 *
 * Supports both single and batch embedding. Batch calls are more efficient
 * because Ollama processes all texts in one forward pass.
 *
 * The embedding dimension is resolved lazily on the first call and cached.
 * `nomic-embed-text` produces 768-dimensional vectors.
 *
 * @example
 * const embedder = new OllamaEmbedder();
 * const { vector } = await embedder.embed("debug a segfault in Rust");
 */
export class OllamaEmbedder implements Embedder {
  private readonly model: string;
  private readonly baseUrl: string;
  private _dimensions: number | undefined;

  constructor(model: string = DEFAULT_MODEL, baseUrl: string = DEFAULT_OLLAMA_URL) {
    this.model = model;
    this.baseUrl = baseUrl;
  }

  get dimensions(): Promise<number> {
    if (this._dimensions !== undefined) {
      return Promise.resolve(this._dimensions);
    }
    // Resolve by embedding a probe string and reading vector length
    return this.embed("probe").then((r) => {
      this._dimensions = r.vector.length;
      return this._dimensions;
    });
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const results = await this.embedBatch([text]);
    const first = results[0];
    if (first === undefined) {
      throw new Error("Ollama returned no embeddings for single text");
    }
    return first;
  }

  async embedBatch(texts: readonly string[]): Promise<readonly EmbeddingResult[]> {
    if (texts.length === 0) return [];

    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!response.ok) {
      throw new Error(`Ollama embed request failed: ${response.status} ${await response.text()}`);
    }

    const data = (await response.json()) as OllamaEmbedResponse;

    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error(
        `Ollama returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} inputs`,
      );
    }

    return data.embeddings.map((vec) => ({
      vector: new Float32Array(vec),
    }));
  }
}

/**
 * Perform a quick health check against the Ollama instance.
 * Returns true if Ollama is reachable, false otherwise.
 * Does not throw — safe to use in fallback logic.
 *
 * @param baseUrl - Ollama base URL (default: http://localhost:11434)
 */
export async function isOllamaReachable(baseUrl: string = DEFAULT_OLLAMA_URL): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}
