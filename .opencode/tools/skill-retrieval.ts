import { tool } from "@opencode-ai/plugin";
import { homedir } from "os";
import { join } from "path";

/**
 * Custom tool that retrieves relevant skill content for a given task.
 *
 * The LLM can call this tool when it wants to load specialised instructions
 * for a task (e.g. "how should I write Rust code?", "what are the testing
 * conventions?"). It returns the merged skill content ready for use as
 * additional context.
 *
 * Backend selection is automatic:
 *   - VectorBackend (semantic search) when Ollama is running and the index exists.
 *   - FileBackend (static routing) as a fallback.
 *
 * The monorepo root is resolved from the AI_CODING_MONOREPO environment
 * variable set by Home Manager.
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
    "Retrieve relevant skill instructions for a given action and optional task description. " +
    "Returns merged skill content (coding standards, workflow rules, language-specific guidance) " +
    "that should be used as additional context when performing the task.",
  args: {
    action: tool.schema
      .enum(["plan", "edit", "debug", "explore", "test", "review", "document", "chat"])
      .describe("The AI action being performed"),
    query: tool.schema
      .string()
      .optional()
      .describe(
        "Optional description of the specific task (e.g. 'implement a Rust parser'). " +
        "Enriches semantic retrieval when the vector backend is active.",
      ),
    workspace: tool.schema
      .string()
      .optional()
      .describe(
        "Absolute path to the workspace directory. " +
        "Used to detect project type (Rust, C++, TypeScript) for domain skill selection.",
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
    const argv = ["run", "skill-retrieval", args.action];
    if (args.query) argv.push("--query", args.query);
    if (args.workspace) argv.push("--workspace", args.workspace);

    try {
      const output = await Bun.$`${bunBin} ${argv}`.cwd(monorepoRoot).text();
      const trimmed = output.trim();
      return trimmed.length > 0 ? trimmed : "No relevant skills found for this action.";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Skill retrieval failed: ${message}`;
    }
  },
});
