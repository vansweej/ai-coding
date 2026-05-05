/**
 * CLI entry point for on-demand skill retrieval.
 *
 * Usage:
 *   bun run packages/skills/src/cli/skill-retrieval-cli.ts <action> [--query <text>] [--workspace <path>]
 *
 * Options:
 *   <action>         Required. One of: plan, edit, debug, explore, test, review, document, chat
 *   --query <text>   Optional task description for richer semantic retrieval.
 *   --workspace <p>  Optional workspace path for project-type detection.
 *
 * Outputs the merged skill content to stdout.
 * Used by the .opencode/tools/skill-retrieval.ts OpenCode tool.
 */

import type { AIAction } from "@ai-coding/shared";
/* v8 ignore start */
import { createBestBackend } from "../backends/create-backend";
import { mergeSkills } from "../merge-skills";
import { resolveSkill } from "../resolve-skill";

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const action = args.find((a) => !a.startsWith("--")) as AIAction | undefined;
const query = option("--query");
const workspace = option("--workspace");

if (!action) {
  console.error(
    "Usage: skill-retrieval <action> [--query <text>] [--workspace <path>]\n" +
      "Actions: plan, edit, debug, explore, test, review, document, chat",
  );
  process.exit(1);
}

const backend = await createBestBackend({ skillRoot: workspace });
const skills = await resolveSkill({ action, workspace, query }, backend);
const merged = mergeSkills(skills);

if (merged.length > 0) {
  process.stdout.write(merged);
} else {
  process.stdout.write("");
}
/* v8 ignore stop */
