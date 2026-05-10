import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Embedder } from "@ai-coding/embeddings";
import { chunkSkill } from "../chunking/markdown-chunker";
import type { LanceStore } from "../store/lance-store";

/** Default skill root — same as FileBackend. */
const DEFAULT_SKILL_ROOT = join(homedir(), ".config", "opencode", "skills");

/** Shape of the `.meta.json` staleness file written alongside the DB. */
export interface SkillIndexMeta {
  /** ISO-8601 timestamp of the last successful index run. */
  readonly lastIndexedAt: string;
  /** Map of skill name → sha256 hex hash of the SKILL.md content at index time. */
  readonly skillHashes: Readonly<Record<string, string>>;
}

/** Result returned by `indexSkills()`. */
export interface IndexResult {
  /** Skills that were newly indexed or re-indexed due to content change. */
  readonly indexed: readonly string[];
  /** Skills that were skipped because their content hash matched the stored meta. */
  readonly skipped: readonly string[];
}

/**
 * Index all SKILL.md files found under `skillRoot` into the LanceDB store.
 *
 * Staleness detection:
 *   - A `.meta.json` file is written alongside the DB directory.
 *   - On each run, the SHA-256 of each SKILL.md is compared to the stored hash.
 *   - Skills whose hash matches are skipped (no re-embedding, no re-insert).
 *   - Skills whose hash differs (or are new) are fully re-indexed.
 *
 * @param embedder  - Embedder to use for generating chunk vectors.
 * @param store     - LanceStore instance (must already be opened, or will be opened here).
 * @param skillRoot - Path to the skill root directory.
 * @param metaPath  - Path to write the `.meta.json` file.
 * @param force     - When true, skip staleness check and re-index everything.
 */
export async function indexSkills(
  embedder: Embedder,
  store: LanceStore,
  skillRoot: string = DEFAULT_SKILL_ROOT,
  metaPath = `${store.dbPath}.meta.json`,
  force = false,
): Promise<IndexResult> {
  // Load existing meta for staleness detection
  const existingMeta = force ? undefined : await loadMeta(metaPath);

  // Discover skill directories
  const skillNames = await discoverSkills(skillRoot);

  // Open the store (no-op if already open)
  const dims = await embedder.dimensions;
  await store.open(dims);

  const indexed: string[] = [];
  const skipped: string[] = [];
  const newHashes: Record<string, string> = { ...(existingMeta?.skillHashes ?? {}) };

  for (const skillName of skillNames) {
    const skillPath = join(skillRoot, skillName, "SKILL.md");
    const file = Bun.file(skillPath);

    if (!(await file.exists())) continue;

    const content = await file.text();
    const hash = await sha256(content);

    if (!force && existingMeta?.skillHashes[skillName] === hash) {
      skipped.push(skillName);
      continue;
    }

    // Chunk → embed → upsert
    const chunks = chunkSkill(skillName, content);
    const embeddings = await embedder.embedBatch(chunks.map((c) => c.text));
    await store.upsertSkill(skillName, chunks, embeddings);

    newHashes[skillName] = hash;
    indexed.push(skillName);
  }

  // Write updated meta
  const meta: SkillIndexMeta = {
    lastIndexedAt: new Date().toISOString(),
    skillHashes: newHashes,
  };
  await Bun.write(metaPath, JSON.stringify(meta, null, 2));

  return { indexed, skipped };
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function discoverSkills(skillRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(skillRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function loadMeta(metaPath: string): Promise<SkillIndexMeta | undefined> {
  const file = Bun.file(metaPath);
  if (!(await file.exists())) return undefined;
  try {
    return (await file.json()) as SkillIndexMeta;
  } catch {
    return undefined;
  }
}

async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
