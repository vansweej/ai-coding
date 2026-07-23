/**
 * Local Result type for {@link CodebaseBackend.search} — mirrors the shape
 * used elsewhere in the monorepo (ai-system/shared/event-types.ts,
 * @ai-coding/pipeline) but is defined locally so `@ai-coding/codebase` stays
 * a dependency-free package (it must not import from `ai-system`).
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/**
 * Sentinel returned by {@link CodebaseBackend.search} when the requested
 * repo (or the global store, when `repoId` is `undefined`) has never been
 * indexed.
 *
 * This is expected control flow, not an exceptional condition — callers
 * (e.g. the retrieval CLI) should treat it as "run `index-codebase` first
 * or fall back to grep", never as an error to surface a stack trace for.
 */
export interface NoIndex {
  readonly kind: "no-index";
  /** Canonical repo identifier, or `undefined` for a cold global store. */
  readonly repoId: string | undefined;
}

/** Construct a successful {@link Result}. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Construct a {@link NoIndex} error wrapped in a {@link Result}. */
export function noIndex(repoId: string | undefined): Result<never, NoIndex> {
  return { ok: false, error: { kind: "no-index", repoId } };
}
