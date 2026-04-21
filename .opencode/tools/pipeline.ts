import { tool } from "@opencode-ai/plugin";

/**
 * Custom tool that runs an ai-coding pipeline from within OpenCode.
 *
 * The LLM can call this tool when it determines that a pipeline is the right
 * action -- for example, when asked to scaffold a new project or run a dev
 * cycle on a workspace.
 *
 * The tool shells out to `bun run pipeline` in the monorepo root and returns
 * the full pipeline output for the LLM to summarise.
 */
export default tool({
  description:
    "Run an ai-coding pipeline (scaffold-rust, scaffold-cpp, dev-cycle, rust-dev-cycle, cmake-dev-cycle). " +
    "Use this when asked to scaffold a new project or run a full plan→implement→test cycle on a workspace.",
  args: {
    name: tool.schema
      .enum([
        "scaffold-rust",
        "scaffold-cpp",
        "dev-cycle",
        "rust-dev-cycle",
        "cmake-dev-cycle",
      ])
      .describe("Pipeline to run"),
    workspace: tool.schema
      .string()
      .describe("Absolute path to the project directory"),
    input: tool.schema
      .string()
      .optional()
      .describe(
        "Optional request text for dev-cycle pipelines (e.g. 'Add error handling to the parser')",
      ),
  },
  async execute(args, context) {
    const monorepoRoot = context.worktree;
    const argv = ["run", "pipeline", args.name, args.workspace];
    if (args.input) {
      argv.push("--input", args.input);
    }
    const cmd = `bun ${argv.join(" ")}`;

    try {
      const output = await Bun.$`bun ${argv}`.cwd(monorepoRoot).text();
      return output.trim() || "Pipeline completed with no output.";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Pipeline failed: ${message}\nCommand: ${cmd}`;
    }
  },
});
