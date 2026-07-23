import ignore, { type Ignore } from "ignore";

/**
 * Root-level control file whose gitignore-syntax patterns EXCLUDE matched
 * files from vectorization at discovery time.
 *
 * Excluded files remain tracked in git and fully browsable/greppable by
 * agents — only the vector index skips them. Intended for large vendored
 * subtrees that provide pattern inspiration but should not be embedded.
 *
 * Root-only: nested `.ai-coding-ignore` files in subdirectories are NOT
 * honored (single source of truth, no per-directory drift).
 */
export const IGNORE_FILE = ".ai-coding-ignore";

/**
 * Root-level control file whose gitignore-syntax patterns EXEMPT matched
 * files from TTL-based purge (retention time), regardless of how old their
 * `indexed_at` timestamp is.
 *
 * Root-only, single glob file — supersedes the old per-directory
 * `.ai-coding-keep` marker scheme.
 */
export const KEEP_FILE = ".ai-coding-keep";

/**
 * Read the raw gitignore-syntax patterns for a root-level control file,
 * combined with any `extraGlobs`. Comments (`#`) and blank lines are
 * stripped. Used both by {@link loadMatcher} and by callers that need to
 * report the active pattern list (e.g. {@link TotalExclusionError}).
 *
 * @param repoRoot   - Absolute path to the repository root.
 * @param filename   - Control filename to read from the repo root.
 * @param extraGlobs - Additional patterns to append.
 * @returns The combined, trimmed, non-empty pattern list.
 */
export async function readPatterns(
  repoRoot: string,
  filename: string,
  extraGlobs: readonly string[] = [],
): Promise<readonly string[]> {
  const file = Bun.file(`${repoRoot}/${filename}`);
  const exists = await file.exists();
  const content = exists ? await file.text() : "";

  const patterns = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  return [...patterns, ...extraGlobs];
}

/**
 * Load a root-level gitignore-syntax control file and build a matcher.
 *
 * Combines the file's patterns (if the file exists and is tracked) with any
 * `extraGlobs` supplied by the caller (e.g. CLI `--exclude` flags). Both
 * `.ai-coding-ignore` and `.ai-coding-keep` share this loader — they differ
 * only in filename and in how the caller uses the resulting matcher.
 *
 * Returns `null` when there are no patterns at all (file absent/empty and no
 * `extraGlobs`), which callers treat as "no filtering" — a normal control-flow
 * outcome, not an error. Genuine I/O errors (e.g. permission failures)
 * propagate to the caller; per package convention this module does not wrap
 * them in a Result, for consistency with `discoverFiles` and the rest of the
 * indexer's file-I/O boundary, which all throw up to the single CLI
 * try/catch.
 *
 * Patterns use standard gitignore syntax, including `!` negation. Paths
 * passed to the returned matcher's `.ignores()` must be repo-relative POSIX
 * paths — exactly what `git ls-files` emits.
 *
 * @param repoRoot   - Absolute path to the repository root.
 * @param filename   - Control filename to read from the repo root
 *                     ({@link IGNORE_FILE} or {@link KEEP_FILE}).
 * @param extraGlobs - Additional gitignore-syntax patterns to combine, e.g.
 *                     from repeatable `--exclude` CLI flags.
 * @returns An `Ignore` matcher, or `null` if there are no patterns to apply.
 */
export async function loadMatcher(
  repoRoot: string,
  filename: string,
  extraGlobs: readonly string[] = [],
): Promise<Ignore | null> {
  const allPatterns = await readPatterns(repoRoot, filename, extraGlobs);
  if (allPatterns.length === 0) return null;

  return ignore().add(allPatterns);
}
