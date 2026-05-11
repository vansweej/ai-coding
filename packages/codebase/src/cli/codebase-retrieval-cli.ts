/**
 * CLI entry point for on-demand codebase retrieval.
 *
 * Usage:
 *   bun run packages/codebase/src/cli/codebase-retrieval-cli.ts <query> \
 *     --workspace <repo-path> [--limit <n>] [--no-refresh] [--db-path <p>] [--model <name>]
 *
 * Arguments:
 *   <query>            Required. Natural-language or code-fragment query string.
 *
 * Options:
 *   --workspace <p>    Repo root to search within and refresh.
 *   --limit <n>        Maximum number of results (default: 10).
 *   --no-refresh       Skip the query-time incremental re-index.
 *   --db-path <p>      Override the LanceDB path.
 *   --model <name>     Ollama embedding model (default: nomic-embed-text).
 *   --grammars <p>     Override the tree-sitter grammars directory.
 *
 * Writes formatted results to stdout.
 * Used by the .opencode/tools/codebase-retrieval.ts OpenCode tool.
 */

/* v8 ignore start */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { OllamaEmbedder, isOllamaReachable } from "@ai-coding/embeddings";

import { ParserPool, DEFAULT_GRAMMARS_DIR } from "../chunking/parser-pool";
import { DEFAULT_CODEBASE_DB_PATH, CodebaseStore } from "../store/codebase-store";
import { CodebaseBackend } from "../backends/codebase-backend";

const args = process.argv.slice(2);

function flag(name: string): boolean {
  return args.includes(name);
}

function option(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] !== undefined ? (args[idx + 1] as string) : fallback;
}

// First positional argument is the query
const query = args.find((a) => !a.startsWith("--"));

if (query === undefined) {
  console.error(
    "Usage: codebase-retrieval <query> [--workspace <path>] [--limit <n>]\n" +
      "                          [--no-refresh] [--db-path <path>] [--model <name>]",
  );
  process.exit(1);
}

const workspaceArg = option("--workspace", "");
const repoPath = workspaceArg.length > 0 ? realpathSync(resolve(workspaceArg)) : undefined;
const limitRaw = option("--limit", "10");
const limit = Number.parseInt(limitRaw, 10);
const noRefresh = flag("--no-refresh");
const dbPath = option("--db-path", DEFAULT_CODEBASE_DB_PATH);
const model = option("--model", "nomic-embed-text");
const grammarsDir = option("--grammars", DEFAULT_GRAMMARS_DIR);

if (Number.isNaN(limit) || limit < 1) {
  console.error(`❌  Invalid --limit value: "${limitRaw}" (must be a positive integer)`);
  process.exit(1);
}

const reachable = await isOllamaReachable();
if (!reachable) {
  console.error("❌  Ollama is not reachable at http://localhost:11434");
  console.error("    Start Ollama with: ollama serve");
  process.exit(1);
}

const embedder = new OllamaEmbedder(model);
const store = new CodebaseStore(dbPath);
const pool = new ParserPool(grammarsDir);
const backend = new CodebaseBackend(embedder, store, pool);

try {
  const results = await backend.search(query, repoPath, {
    limit,
    refresh: !noRefresh,
  });

  if (results.length === 0) {
    process.stdout.write("");
    process.exit(0);
  }

  const output = results
    .map((r, i) => {
      const location = `${r.filePath}:${r.startLine}-${r.endLine}`;
      const symbol =
        r.symbolName !== null ? ` (${r.symbolKind?.replace(/_/g, " ")}: ${r.symbolName})` : "";
      const header = `### [${i + 1}] ${location}${symbol}`;
      return `${header}\n\n${r.text}`;
    })
    .join("\n\n---\n\n");

  process.stdout.write(output);
} catch (err) {
  console.error("❌  Retrieval failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
/* v8 ignore stop */
