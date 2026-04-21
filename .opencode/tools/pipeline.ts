import { tool } from "@opencode-ai/plugin";
import { homedir } from "os";
import { join, resolve } from "path";

/**
 * Custom tool that runs an ai-coding pipeline from within OpenCode.
 *
 * The LLM can call this tool when it determines that a pipeline is the right
 * action -- for example, when asked to scaffold a new project or run a dev
 * cycle on a workspace.
 *
 * The monorepo root is resolved from the AI_CODING_MONOREPO environment
 * variable, which is set globally by Home Manager. This allows the tool to
 * work from any project directory.
 *
 * The tool shells out to `bun run pipeline` in the monorepo root and returns
 * the full pipeline output for the LLM to summarise.
 *
 * Bun is resolved by probing known Nix and system locations so the tool
 * works even when OpenCode does not inherit the full login PATH.
 */

/** Candidate locations for the bun binary, in priority order. */
const BUN_CANDIDATES = [
  join(homedir(), ".nix-profile", "bin", "bun"),
  "/nix/var/nix/profiles/default/bin/bun",
  "/usr/local/bin/bun",
  "/usr/bin/bun",
  "bun", // fallback: rely on PATH
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
      .describe("Path to the project directory (absolute or relative; use '.' for current directory)"),
    input: tool.schema
      .string()
      .optional()
      .describe(
        "Optional request text for dev-cycle pipelines (e.g. 'Add error handling to the parser')",
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
    const workspace = resolve(args.workspace);
    const argv = ["run", "pipeline", args.name, workspace];
    if (args.input) {
      argv.push("--input", args.input);
    }
    const cmd = `${bunBin} ${argv.join(" ")}`;

    try {
      const output = await Bun.$`${bunBin} ${argv}`.cwd(monorepoRoot).text();
      return output.trim() || "Pipeline completed with no output.";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Pipeline failed: ${message}\nCommand: ${cmd}`;
    }
  },
});
