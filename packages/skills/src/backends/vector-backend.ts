import type { Embedder } from "../embeddings/embedder-types";
import type { ResolvedSkill, RetrievalContext, SkillBackend } from "../skill-types";
import type { LanceStore } from "../store/lance-store";

/**
 * Approximate characters-per-token ratio for token-budget estimation.
 * 4 chars ≈ 1 token is a widely-used heuristic for English prose.
 */
const CHARS_PER_TOKEN = 4;

/** Default token budget for retrieved skill content (~2000 tokens). */
const DEFAULT_TOKEN_BUDGET = 2000;

/** Maximum number of candidate chunks to fetch from LanceDB before budget pruning. */
const CANDIDATE_LIMIT = 20;

/**
 * Vector-based skill backend that retrieves semantically relevant skill chunks
 * from a LanceDB store using Ollama embeddings.
 *
 * Retrieval strategy:
 *   1. Embed the query string (action label + optional user input).
 *   2. Fetch up to `CANDIDATE_LIMIT` nearest-neighbour chunks from LanceDB.
 *   3. Accumulate chunks in distance order until the token budget is exhausted.
 *   4. Group surviving chunks by skill name and concatenate their text.
 *   5. Return one `ResolvedSkill` per unique skill name, ordered by first appearance.
 *
 * The `relevance` field on each `ResolvedSkill` is set to `1 - normalised_distance`
 * so that 1.0 = perfect match and 0.0 = maximally distant.
 *
 * Falls back gracefully when the store is empty: returns an empty array.
 *
 * @example
 * const backend = new VectorBackend(embedder, store);
 * const skills = await backend.resolve({ action: "edit", query: "refactor the parser" });
 */
export class VectorBackend implements SkillBackend {
  private readonly embedder: Embedder;
  private readonly store: LanceStore;
  private readonly tokenBudget: number;

  constructor(embedder: Embedder, store: LanceStore, tokenBudget: number = DEFAULT_TOKEN_BUDGET) {
    this.embedder = embedder;
    this.store = store;
    this.tokenBudget = tokenBudget;
  }

  /**
   * Resolve skills semantically relevant to the given context.
   *
   * @param context - Retrieval context. `context.query` enriches the embedding;
   *                  when absent, only the action label is embedded.
   * @returns Ordered array of resolved skills within the token budget.
   */
  async resolve(context: RetrievalContext): Promise<readonly ResolvedSkill[]> {
    const queryText = buildQueryText(context);
    const { vector } = await this.embedder.embed(queryText);

    const candidates = await this.store.search(vector, CANDIDATE_LIMIT);
    if (candidates.length === 0) return [];

    // Normalise distances for relevance scoring (0 = best, higher = worse)
    const maxDist = Math.max(...candidates.map((c) => c._distance), 1e-9);

    // Accumulate chunks within token budget, preserving distance order
    const charBudget = this.tokenBudget * CHARS_PER_TOKEN;
    let usedChars = 0;

    // Map: skillName → ordered chunk texts
    const skillChunks = new Map<string, string[]>();
    const skillMaxDist = new Map<string, number>();

    for (const row of candidates) {
      if (usedChars + row.text.length > charBudget) continue;
      usedChars += row.text.length;

      const existing = skillChunks.get(row.skill_name) ?? [];
      existing.push(row.text);
      skillChunks.set(row.skill_name, existing);

      // Track the minimum distance (best relevance) for each skill
      const prev = skillMaxDist.get(row.skill_name) ?? Number.POSITIVE_INFINITY;
      if (row._distance < prev) skillMaxDist.set(row.skill_name, row._distance);
    }

    // Build ResolvedSkill[] in insertion order (closest chunk first)
    const resolved: ResolvedSkill[] = [];
    for (const [name, chunks] of skillChunks) {
      const dist = skillMaxDist.get(name) ?? 0;
      const relevance = 1 - dist / maxDist;
      resolved.push({
        name,
        content: chunks.join("\n\n---\n\n"),
        relevance,
      });
    }

    return resolved;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the query string to embed.
 * Combines the action label with the user's input for richer semantic matching.
 */
function buildQueryText(context: RetrievalContext): string {
  const parts: string[] = [context.action];
  if (context.query) parts.push(context.query);
  return parts.join(" ");
}
