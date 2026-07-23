import { existsSync } from "node:fs";

import type { Ignore } from "ignore";

import type { CodebaseStore } from "../store/codebase-store";
import { DEFAULT_TTL_DAYS } from "../store/codebase-store";

/**
 * Result of a post-index purge sweep.
 */
export interface PurgeResult {
  /** ISO-8601 cutoff date used for the TTL sweep. */
  readonly staleBefore: string;
  /** Repo IDs whose root directory no longer exists on disk and were purged. */
  readonly deadRepos: readonly string[];
}

/**
 * Delete rows in one repo whose `indexed_at` timestamp is older than `ttlDays`
 * ago, except rows matching `keepMatcher`.
 *
 * @param store       - Opened CodebaseStore.
 * @param repoId      - Canonical repo identifier to scope the purge to.
 * @param keepMatcher - Matcher built from `.ai-coding-keep`; matched file
 *                      paths are exempt from the TTL sweep. `null` means no
 *                      exemptions.
 * @param ttlDays     - Rows older than this many days are deleted. Default: 30.
 * @returns ISO-8601 cutoff date string that was used.
 */
export async function purgeStale(
  store: CodebaseStore,
  repoId: string,
  keepMatcher: Ignore | null = null,
  ttlDays: number = DEFAULT_TTL_DAYS,
): Promise<string> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - ttlDays);
  const cutoffIso = cutoff.toISOString();

  const stalePaths = await store.queryStalePaths(repoId, cutoffIso);
  const toDelete = keepMatcher ? stalePaths.filter((p) => !keepMatcher.ignores(p)) : stalePaths;
  await store.deleteFilesByPaths(repoId, toDelete);

  return cutoffIso;
}

/**
 * Delete rows for every repo whose root directory no longer exists on disk.
 *
 * Queries all distinct `repo_id` values from the store and removes any whose
 * corresponding path does not pass `existsSync`. Used to clean up repos that
 * have been deleted or moved since the last index run.
 *
 * @param store - Opened CodebaseStore.
 * @returns List of repo IDs that were purged.
 */
export async function purgeDeadRepos(store: CodebaseStore): Promise<readonly string[]> {
  const repoIds = await store.listRepoIds();
  const dead: string[] = [];

  for (const repoId of repoIds) {
    if (!existsSync(repoId)) {
      await store.deleteRepo(repoId);
      dead.push(repoId);
    }
  }

  return dead;
}

/**
 * Purge all chunks for a specific repository.
 *
 * Convenience wrapper around `store.deleteRepo()` for use in the CLI
 * `--purge-repo` flag and integration tests.
 *
 * @param store  - Opened CodebaseStore.
 * @param repoId - Canonical repo identifier (absolute repo root path).
 */
export async function purgeRepo(store: CodebaseStore, repoId: string): Promise<void> {
  await store.deleteRepo(repoId);
}

/**
 * Run the full post-index purge pipeline:
 *   1. TTL sweep — delete current-repo rows older than `ttlDays`, except rows
 *      matching `keepMatcher`.
 *   2. Dead-repo sweep — delete rows for repos whose directory no longer exists.
 *
 * Called automatically by `indexCodebase()` after every indexing run.
 *
 * @param store       - Opened CodebaseStore.
 * @param repoId      - Canonical repo identifier to scope the TTL purge to.
 * @param keepMatcher - Matcher built from `.ai-coding-keep`; matched file
 *                      paths are exempt from the TTL sweep. `null` means no
 *                      exemptions.
 * @param ttlDays     - TTL in days (default: {@link DEFAULT_TTL_DAYS}).
 */
export async function runPostIndexPurge(
  store: CodebaseStore,
  repoId: string,
  keepMatcher: Ignore | null = null,
  ttlDays: number = DEFAULT_TTL_DAYS,
): Promise<PurgeResult> {
  const staleBefore = await purgeStale(store, repoId, keepMatcher, ttlDays);
  const deadRepos = await purgeDeadRepos(store);
  return { staleBefore, deadRepos };
}
