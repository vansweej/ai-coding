import type { Embedder } from "@ai-coding/embeddings";

import { realpathSync } from "node:fs";
import { chunkFile } from "../chunking/code-chunker";
import type { ParserPool } from "../chunking/parser-pool";
import { detectLanguage } from "../discovery/detect-language";

import { discoverFiles, resolveFilePath } from "../discovery/discover-files";
import { IGNORE_FILE, KEEP_FILE, loadMatcher, readPatterns } from "../discovery/pattern-config";
import type { CodebaseStore } from "../store/codebase-store";
import { type PurgeResult, runPostIndexPurge } from "./purge";

// ── errors ────────────────────────────────────────────────────────────────────

/**
 * Thrown when every discovered file in a repo is excluded by
 * `.ai-coding-ignore` and/or `--exclude` patterns, leaving nothing to index.
 *
 * This is treated as a configuration mistake (over-broad pattern or stray
 * negation) rather than a valid "empty repo" state, and aborts BEFORE the
 * store is opened — the database is left completely untouched.
 */
export class TotalExclusionError extends Error {
  readonly ignorePatterns: readonly string[];
  readonly excludeGlobs: readonly string[];

  constructor(
    discoveredCount: number,
    ignorePatterns: readonly string[],
    excludeGlobs: readonly string[],
  ) {
    const patternsMsg = `Active ignore patterns: [${ignorePatterns.join(", ")}]; --exclude flags: [${excludeGlobs.join(", ")}].`;
    super(
      `All ${discoveredCount} discovered file(s) were excluded by ${IGNORE_FILE} and/or --exclude patterns. Nothing was indexed; the database was not touched. ${patternsMsg} Check for an over-broad glob (e.g. bare '*' or '**') or a stray '!' negation.`,
    );
    this.name = "TotalExclusionError";
    this.ignorePatterns = ignorePatterns;
    this.excludeGlobs = excludeGlobs;
  }
}

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
  /**
   * Maximum file size in bytes. Files exceeding this limit are skipped without
   * reading their content into memory — they are reported in `result.oversized`.
   *
   * The check uses `Bun.file().size` (bytes) before calling `.text()`. For
   * UTF-8 source code bytes >= chars, making this a safe conservative filter
   * that avoids loading huge files into memory before discarding them.
   *
   * Note: `force: true` does NOT override this limit — you cannot embed a
   * file that exceeds the embedding model's context window regardless.
   *
   * Default: `100_000`.
   */
  readonly maxFileSizeBytes?: number;
  /**
   * Additional gitignore-syntax patterns to exclude from vectorization, on
   * top of the repo's root `.ai-coding-ignore` file. Composes onto the same
   * matcher (repeatable `--exclude` CLI flags feed this).
   */
  readonly excludeGlobs?: readonly string[];
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
   * (deleted, `.gitignore`d, or newly matched by `.ai-coding-ignore`). Their
   * chunks have been removed from the store.
   */
  readonly deleted: readonly string[];
  /**
   * Files skipped because their byte size exceeds `maxFileSizeBytes`.
   * These are never read into memory. Their hash is stored as `""` so they
   * are not re-attempted on subsequent runs unless the file shrinks below
   * the limit (at which point the hash changes and the file is re-indexed).
   */
  readonly oversized: readonly string[];
  /**
   * Number of discovered files excluded from vectorization by
   * `.ai-coding-ignore` and/or `--exclude` patterns.
   */
  readonly ignoredCount: number;
  /** Active `.ai-coding-ignore` + `--exclude` patterns, for reporting. */
  readonly ignorePatterns: readonly string[];
  /** Active `.ai-coding-keep` patterns exempting files from TTL purge, for reporting. */
  readonly keepPatterns: readonly string[];
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
  const { force = false, ttlDays, maxFileSizeBytes = 100_000, excludeGlobs = [] } = options;
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

  // Discovery-time exclusion: .ai-coding-ignore + --exclude compose onto one matcher
  const ignorePatterns = await readPatterns(repoPath, IGNORE_FILE);
  const ignoreMatcher = await loadMatcher(repoPath, IGNORE_FILE, excludeGlobs);
  const filesToIndex = ignoreMatcher
    ? discoveredFiles.filter((f) => !ignoreMatcher.ignores(f))
    : discoveredFiles;
  const ignoredCount = discoveredFiles.length - filesToIndex.length;

  // Retention-time exemption: .ai-coding-keep, threaded into the purge step only
  const keepPatterns = await readPatterns(repoPath, KEEP_FILE);
  const keepMatcher = await loadMatcher(repoPath, KEEP_FILE);

  // Hard-abort BEFORE the store is opened — nothing indexed, DB untouched.
  if (discoveredFiles.length > 0 && filesToIndex.length === 0) {
    throw new TotalExclusionError(discoveredFiles.length, ignorePatterns, excludeGlobs);
  }

  const discoveredSet = new Set(filesToIndex);

  // Open the store (idempotent)
  const dims = await embedder.dimensions;
  await store.open(dims);

  const indexed: string[] = [];
  const skipped: string[] = [];
  const oversized: string[] = [];
  const newFileHashes: Record<string, string> = {};
  const pendingUpserts: Parameters<CodebaseStore["upsertFiles"]>[0][number][] = [];

  for (const filePath of filesToIndex) {
    const absolutePath = resolveFilePath(repoPath, filePath);
    const file = Bun.file(absolutePath);

    if (!(await file.exists())) continue;

    // Check byte size before reading content into memory.
    // For UTF-8 source code bytes >= chars, so this is a safe conservative
    // check. The hash is preserved as "" so the file is not re-attempted on
    // subsequent runs unless its content changes (and thus its size changes).
    if (file.size > maxFileSizeBytes) {
      console.warn(`⚠️   Skipping oversized file (${file.size} bytes): ${filePath}`);
      oversized.push(filePath);
      newFileHashes[filePath] = existingRepoMeta.fileHashes[filePath] ?? "";
      continue;
    }

    const content = await file.text();
    const hash = await sha256(content);

    // Skip files whose content hash has not changed
    if (!force && existingRepoMeta.fileHashes[filePath] === hash) {
      skipped.push(filePath);
      newFileHashes[filePath] = hash;
      continue;
    }

    // Chunk → embed → queue for one bulk store write after discovery.
    const language = detectLanguage(filePath);
    const chunks = await chunkFile(pool, repoId, filePath, content, language);
    const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));
    pendingUpserts.push({ repoId, filePath, chunks, embeddings });

    newFileHashes[filePath] = hash;
    indexed.push(filePath);
  }

  await store.upsertFiles(pendingUpserts);

  // Delete chunks for files that no longer appear in the (filtered) repo set.
  // Files that become newly excluded by .ai-coding-ignore also fall out of
  // discoveredSet here, so they are removed just like deleted/gitignored files —
  // this is the delete-loop that enforces ignore > keep for previously-indexed rows.
  const deleted: string[] = [];
  for (const prevFile of Object.keys(existingRepoMeta.fileHashes)) {
    if (!discoveredSet.has(prevFile)) {
      await store.deleteFile(repoId, prevFile);
      deleted.push(prevFile);
    }
  }

  const now = new Date().toISOString();

  // Refresh rows that survived the index/delete loop, including hash-skipped files.
  await store.touchRepo(repoId, now);

  // Post-index purge (current-repo TTL sweep + global dead-repo cleanup)
  const purgeResult: PurgeResult = await runPostIndexPurge(store, repoId, keepMatcher, ttlDays);

  // Persist updated meta
  const updatedMeta: GlobalMeta = {
    repos: {
      ...globalMeta.repos,
      [repoId]: {
        lastIndexedAt: now,
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
    oversized,
    ignoredCount,
    ignorePatterns,
    keepPatterns,
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
