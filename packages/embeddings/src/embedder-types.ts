/**
 * Shared types for the embedding abstraction.
 * Kept separate so backends and the store can import without circular deps.
 */

/** A single embedding vector result. */
export interface EmbeddingResult {
  /** The embedding vector as a 32-bit float array. */
  readonly vector: Float32Array;
}

/**
 * Pluggable embedder interface.
 * Consumers are blind to whether embeddings come from Ollama, OpenAI, etc.
 */
export interface Embedder {
  /** Embed a single text string. */
  embed(text: string): Promise<EmbeddingResult>;
  /** Embed multiple texts in one batch call (more efficient than looping embed()). */
  embedBatch(texts: readonly string[]): Promise<readonly EmbeddingResult[]>;
  /**
   * Number of dimensions in the embedding vectors produced by this embedder.
   * Resolved lazily on first call; cached thereafter.
   */
  readonly dimensions: Promise<number>;
}
