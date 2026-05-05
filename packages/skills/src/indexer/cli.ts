/**
 * CLI entry point for the skill indexer.
 *
 * Usage:
 *   bun run packages/skills/src/indexer/cli.ts [--force] [--skill-root <path>]
 *
 * Options:
 *   --force        Re-index all skills, ignoring staleness hashes.
 *   --skill-root   Override the default skill root (~/.config/opencode/skill).
 *   --db-path      Override the LanceDB path (~/.local/share/ai-coding/skills.lance).
 *   --model        Ollama model name for embeddings (default: nomic-embed-text).
 */

/* v8 ignore start */
import { homedir } from "node:os";
import { join } from "node:path";

import { OllamaEmbedder, isOllamaReachable } from "../embeddings/ollama-embedder";
import { LanceStore } from "../store/lance-store";
import { indexSkills } from "./index-skills";

const args = process.argv.slice(2);

function flag(name: string): boolean {
  return args.includes(name);
}

function option(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] !== undefined ? (args[idx + 1] as string) : fallback;
}

const force = flag("--force");
const skillRoot = option("--skill-root", join(homedir(), ".config", "opencode", "skill"));
const dbPath = option("--db-path", join(homedir(), ".local", "share", "ai-coding", "skills.lance"));
const model = option("--model", "nomic-embed-text");

console.log("🔍  Checking Ollama availability…");
const reachable = await isOllamaReachable();
if (!reachable) {
  console.error("❌  Ollama is not reachable at http://localhost:11434");
  console.error("    Start Ollama with: ollama serve");
  process.exit(1);
}

console.log(`📚  Indexing skills from: ${skillRoot}`);
console.log(`💾  LanceDB path:         ${dbPath}`);
console.log(`🤖  Embedding model:      ${model}`);
if (force) console.log("⚡  Force mode: re-indexing all skills");

const embedder = new OllamaEmbedder(model);
const store = new LanceStore(dbPath);
const metaPath = `${dbPath}.meta.json`;

try {
  const result = await indexSkills(embedder, store, skillRoot, metaPath, force);

  if (result.indexed.length > 0) {
    console.log(`\n✅  Indexed (${result.indexed.length}):`);
    for (const name of result.indexed) {
      console.log(`    • ${name}`);
    }
  }

  if (result.skipped.length > 0) {
    console.log(`\n⏭️   Skipped unchanged (${result.skipped.length}):`);
    for (const name of result.skipped) {
      console.log(`    • ${name}`);
    }
  }

  if (result.indexed.length === 0 && result.skipped.length === 0) {
    console.log("\n⚠️   No skills found. Check --skill-root path.");
  }

  console.log("\n✨  Done.");
} catch (err) {
  console.error("❌  Indexing failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
/* v8 ignore stop */
