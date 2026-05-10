/**
 * CLI entry point for the codebase indexer.
 *
 * Usage:
 *   bun run packages/codebase/src/indexer/cli.ts <repo-path> [options]
 *
 * Arguments:
 *   <repo-path>     Required (unless --purge-only). Absolute or relative path
 *                   to the git repository root to index.
 *
 * Options:
 *   --force         Re-index all files, ignoring staleness hashes.
 *   --purge-only    Run only the TTL + dead-repo purge; skip indexing.
 *   --ttl <days>    TTL in days for stale-row purging (default: 30).
 *   --db-path <p>   Override the LanceDB path.
 *   --model <name>  Ollama embedding model (default: nomic-embed-text).
 *   --grammars <p>  Override the tree-sitter grammars directory.
 */

/* v8 ignore start */
import { resolve } from "node:path";

import { OllamaEmbedder, isOllamaReachable } from "@ai-coding/embeddings";

import { DEFAULT_GRAMMARS_DIR, ParserPool } from "../chunking/parser-pool";
import { CodebaseStore, DEFAULT_CODEBASE_DB_PATH, DEFAULT_TTL_DAYS } from "../store/codebase-store";
import { indexCodebase } from "./index-codebase";
import { runPostIndexPurge } from "./purge";

const args = process.argv.slice(2);

function flag(name: string): boolean {
  return args.includes(name);
}

function option(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] !== undefined ? (args[idx + 1] as string) : fallback;
}

const repoArg = args.find((a) => !a.startsWith("--"));
const force = flag("--force");
const purgeOnly = flag("--purge-only");
const ttlRaw = option("--ttl", String(DEFAULT_TTL_DAYS));
const ttlDays = Number.parseInt(ttlRaw, 10);
const dbPath = option("--db-path", DEFAULT_CODEBASE_DB_PATH);
const model = option("--model", "nomic-embed-text");
const grammarsDir = option("--grammars", DEFAULT_GRAMMARS_DIR);

if (!purgeOnly && repoArg === undefined) {
  console.error(
    "Usage: index-codebase <repo-path> [--force] [--purge-only] [--ttl <days>]\n" +
      "                     [--db-path <path>] [--model <name>] [--grammars <dir>]",
  );
  process.exit(1);
}

if (Number.isNaN(ttlDays)) {
  console.error(`❌  Invalid --ttl value: "${ttlRaw}" (must be an integer)`);
  process.exit(1);
}

console.log("🔍  Checking Ollama availability…");
const reachable = await isOllamaReachable();
if (!reachable) {
  console.error("❌  Ollama is not reachable at http://localhost:11434");
  console.error("    Start Ollama with: ollama serve");
  process.exit(1);
}

const store = new CodebaseStore(dbPath);

if (purgeOnly) {
  console.log(`💾  LanceDB path: ${dbPath}`);
  console.log(`🧹  Running purge only (TTL = ${ttlDays} days)…`);

  await store.open();
  const purgeResult = await runPostIndexPurge(store, ttlDays);

  console.log(`✅  Purged rows older than: ${purgeResult.staleBefore}`);
  if (purgeResult.deadRepos.length > 0) {
    console.log(`🗑️   Removed dead repos (${purgeResult.deadRepos.length}):`);
    for (const repo of purgeResult.deadRepos) {
      console.log(`    • ${repo}`);
    }
  } else {
    console.log("✅  No dead repos found.");
  }
  console.log("\n✨  Done.");
  process.exit(0);
}

const repoPath = resolve(repoArg as string);

console.log(`📂  Repository: ${repoPath}`);
console.log(`💾  LanceDB path: ${dbPath}`);
console.log(`🤖  Embedding model: ${model}`);
console.log(`📁  Grammars dir: ${grammarsDir}`);
if (force) console.log("⚡  Force mode: re-indexing all files");
if (ttlDays !== DEFAULT_TTL_DAYS) console.log(`⏱️   TTL: ${ttlDays} days`);

const embedder = new OllamaEmbedder(model);
const pool = new ParserPool(grammarsDir);

try {
  const result = await indexCodebase(embedder, store, pool, repoPath, {
    force,
    ttlDays,
  });

  if (result.indexed.length > 0) {
    console.log(`\n✅  Indexed (${result.indexed.length}):`);
    for (const f of result.indexed) {
      console.log(`    • ${f}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log(`\n⏭️   Skipped unchanged (${result.skipped.length})`);
  }

  if (result.deleted.length > 0) {
    console.log(`\n🗑️   Removed deleted files (${result.deleted.length}):`);
    for (const f of result.deleted) {
      console.log(`    • ${f}`);
    }
  }

  if (result.deadRepos.length > 0) {
    console.log(`\n🧹  Purged dead repos (${result.deadRepos.length}):`);
    for (const repo of result.deadRepos) {
      console.log(`    • ${repo}`);
    }
  }

  if (result.indexed.length === 0 && result.skipped.length === 0 && result.deleted.length === 0) {
    console.log("\n⚠️   No files found. Is the repo empty or is git ls-files returning nothing?");
  }

  console.log(`\n✨  Done. Rows older than ${result.staleBefore} were purged.`);
} catch (err) {
  console.error("❌  Indexing failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
/* v8 ignore stop */
