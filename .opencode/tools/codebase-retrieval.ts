import { tool } from "@opencode-ai/plugin";
import { homedir } from "os";
import { join, resolve } from "path";

/**
 * Custom tool that performs semantic code search over indexed repositories.
 *
 * The LLM can call this tool when it needs to find relevant code in a
 * repository without reading every file — for example, to locate where
 * a concept is implemented, find usages of a function, or understand
 * the structure of an unfamiliar codebase.
 *
 * Before searching, an incremental re-index runs automatically (unless
 * `refresh` is false) so results reflect uncommitted changes.
 *
 * Prerequisites:
 *   - Ollama running locally with `nomic-embed-text` pulled.
 *   - At least one `bun run index-codebase <repo>` run has completed, OR
 *     `refresh` is left as true (the default) so the first search triggers
 *     an initial index.
 *
 * The monorepo root is resolved from the AI_CODING_MONOREPO environment
 * variable set globally by Home Manager.
 */

/** Candidate locations for the bun binary, in priority order. */
const BUN_CANDIDATES = [
  join(homedir(), ".nix-profile", "bin", "bun"),
  "/nix/var/nix/profiles/default/bin/bun",
  "/usr/local/bin/bun",
  "/usr/bin/bun",
  "bun",
];

async function resolveBun(): Promise<string> {
  for (const candidate of BUN_CANDIDATES) {
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }
  return "bun";
}

export default tool({
  description:
    "Search the codebase index for source-code chunks semantically similar to a query. " +
    "Use this to find relevant implementations, understand unfamiliar code, or locate " +
    "where a concept is defined — without reading every file. " +
    "Requires Ollama running locally with nomic-embed-text. " +
    "An incremental re-index runs automatically before each search (unless refresh=false).",
  args: {
    query: tool.schema
      .string()
      .describe(
        "Natural-language or code-fragment search query. " +
        "Examples: 'hash-based staleness check', 'LanceDB upsert strategy', 'purge stale rows'.",
      ),
    workspace: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path to the repository to search. " +
        "When provided, results are restricted to that repo and an incremental refresh is run first. " +
        "Omit to search across all indexed repositories.",
      ),
    limit: tool.schema
      .number()
      .optional()
      .describe("Maximum number of results to return. Default: 10."),
    refresh: tool.schema
      .boolean()
      .optional()
      .describe(
        "When true (default), run an incremental re-index before searching so results " +
        "reflect uncommitted changes. Set to false for faster queries on large repos " +
        "where a nightly index-codebase run is the primary indexing mechanism.",
      ),
  },
  async execute(args) {
    const monorepoRoot = process.env.AI_CODING_MONOREPO;
    if (!monorepoRoot) {
      return (
        "Error: AI_CODING_MONOREPO environment variable is not set. " +
        "It should be set globally by Home Manager to the path of the ai-coding monorepo."
      );
    }

    const bunBin = await resolveBun();
    const argv = ["run", "codebase-retrieval", args.query];

    if (args.workspace) {
      argv.push("--workspace", resolve(args.workspace));
    }
    if (args.limit !== undefined) {
      argv.push("--limit", String(args.limit));
    }
    if (args.refresh === false) {
      argv.push("--no-refresh");
    }

    try {
      const output = await Bun.$`${bunBin} ${argv}`.cwd(monorepoRoot).text();
      const trimmed = output.trim();
      return trimmed.length > 0 ? trimmed : "No results found for this query.";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Codebase search failed: ${message}`;
    }
  },
});
