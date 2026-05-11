import type { Embedder } from "@ai-coding/embeddings";

import { chunkFile } from "../chunking/code-chunker";
import type { ParserPool } from "../chunking/parser-pool";
import { detectLanguage } from "../discovery/detect-language";
import { realpathSync } from "node:fs";

import { discoverFiles, resolveFilePath } from "../discovery/discover-files";
import type { CodebaseStore } from "../store/codebase-store";
import { type PurgeResult, runPostIndexPurge } from "./purge";

// ── public types ──────────────────────────────────────────────────────────────

/** Options for {@link indexCodebase}. */
export interface IndexCodebaseOptions {
  /**
   * When true, skip the staleness hash check and re-index all discovered files.
   * Default: `false`.
   */
  readonly force?: boolean;
  /**
   * Override the path to the global meta JSON file used for staleness tracking.
   * Default: `${store.dbPath}.meta.json`.
   */
  readonly metaPath?: string;
  /**
   * TTL in days for the post-index purge sweep.
   * Default: {@link DEFAULT_TTL_DAYS} (30).
   */
  readonly ttlDays?: number;
}

/** Result returned by {@link indexCodebase}. */
export interface IndexCodebaseResult {
  /** The canonical repo identifier used as `repo_id` in the store (= `repoPath`). */
  readonly repoId: string;
  /** Files that were newly indexed or re-indexed due to a content change. */
  readonly indexed: readonly string[];
  /** Files that were skipped because their content hash matched the stored value. */
  readonly skipped: readonly string[];
  /**
   * Files that were present in the previous meta but are no longer discovered
   * (deleted or `.gitignore`d). Their chunks have been removed from the store.
   */
  readonly deleted: readonly string[];
  /** ISO-8601 cutoff date used for the TTL purge sweep. */
  readonly staleBefore: string;
  /** Repo IDs whose root directory no longer exists on disk and were purged. */
  readonly deadRepos: readonly string[];
}

// ── internal meta types ───────────────────────────────────────────────────────

interface RepoMeta {
  lastIndexedAt: string;
  /** filePath (relative to repo root) → sha256(content) */
  fileHashes: Record<string, string>;
}

/** Single JSON file tracking all indexed repos. */
interface GlobalMeta {
  repos: Record<string, RepoMeta>;
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Index a git repository into the codebase LanceDB store.
 *
 * ## What it does
 * 1. Discovers all indexable files via `git ls-files`.
 * 2. Checks per-file SHA-256 hashes against the stored meta to skip unchanged files.
 * 3. Chunks changed/new files (tree-sitter if a grammar is installed, fallback otherwise).
 * 4. Embeds the chunks and upserts them into the store.
 * 5. Deletes store rows for files removed from the repo since the last run.
 * 6. Runs a TTL + dead-repo purge sweep.
 * 7. Writes the updated meta file.
 *
 * ## Staleness detection
 * A global meta JSON (`${store.dbPath}.meta.json` by default) tracks the
 * SHA-256 hash of every indexed file, keyed by `repoId → filePath`. On each
 * run only files whose hash changed are re-embedded — unchanged files are
 * skipped and their existing store rows are preserved.
 *
 * Pass `force: true` to bypass the hash check and re-index everything.
 *
 * @param embedder - Embedder used to produce chunk vectors.
 * @param store    - LanceDB store (opened here if not yet open).
 * @param pool     - Parser pool for tree-sitter chunking.
 * @param repoPath - Absolute path to the repository root (becomes `repoId`).
 * @param options  - Optional overrides.
 * @throws If `repoPath` is not a git repository (propagated from `discoverFiles`).
 */
export async function indexCodebase(
  embedder: Embedder,
  store: CodebaseStore,
  pool: ParserPool,
  repoPath: string,
  options: IndexCodebaseOptions = {},
): Promise<IndexCodebaseResult> {
  const { force = false, ttlDays } = options;
  const metaPath = options.metaPath ?? `${store.dbPath}.meta.json`;
  const repoId = realpathSync(repoPath);

  // Load existing meta (empty on first run or when force=true)
  const globalMeta: GlobalMeta = force ? { repos: {} } : await loadGlobalMeta(metaPath);
  const existingRepoMeta: RepoMeta = globalMeta.repos[repoId] ?? {
    lastIndexedAt: "",
    fileHashes: {},
  };

  // Discover all current indexable files (throws if not a git repo)
  const discoveredFiles = await discoverFiles(repoPath);
  const discoveredSet = new Set(discoveredFiles);

  // Open the store (idempotent)
  const dims = await embedder.dimensions;
  await store.open(dims);

  const indexed: string[] = [];
  const skipped: string[] = [];
  const newFileHashes: Record<string, string> = {};

  for (const filePath of discoveredFiles) {
    const absolutePath = resolveFilePath(repoPath, filePath);
    const file = Bun.file(absolutePath);

    if (!(await file.exists())) continue;

    const content = await file.text();
    const hash = await sha256(content);

    // Skip files whose content hash has not changed
    if (!force && existingRepoMeta.fileHashes[filePath] === hash) {
      skipped.push(filePath);
      newFileHashes[filePath] = hash;
      continue;
    }

    // Chunk → embed → upsert
    const language = detectLanguage(filePath);
    const chunks = await chunkFile(pool, repoId, filePath, content, language);
    const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));
    await store.upsertFile(repoId, filePath, chunks, embeddings);

    newFileHashes[filePath] = hash;
    indexed.push(filePath);
  }

  // Delete chunks for files that no longer appear in the repo
  const deleted: string[] = [];
  for (const prevFile of Object.keys(existingRepoMeta.fileHashes)) {
    if (!discoveredSet.has(prevFile)) {
      await store.deleteFile(repoId, prevFile);
      deleted.push(prevFile);
    }
  }

  // Post-index purge (TTL sweep + dead-repo cleanup)
  const purgeResult: PurgeResult = await runPostIndexPurge(store, ttlDays);

  // Persist updated meta
  const updatedMeta: GlobalMeta = {
    repos: {
      ...globalMeta.repos,
      [repoId]: {
        lastIndexedAt: new Date().toISOString(),
        fileHashes: newFileHashes,
      },
    },
  };
  await Bun.write(metaPath, JSON.stringify(updatedMeta, null, 2));

  return {
    repoId,
    indexed,
    skipped,
    deleted,
    staleBefore: purgeResult.staleBefore,
    deadRepos: purgeResult.deadRepos,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function loadGlobalMeta(metaPath: string): Promise<GlobalMeta> {
  const file = Bun.file(metaPath);
  if (!(await file.exists())) return { repos: {} };
  try {
    return (await file.json()) as GlobalMeta;
  } catch {
    return { repos: {} };
  }
}

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
