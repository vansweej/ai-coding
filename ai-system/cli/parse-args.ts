import type { Result } from "@ai-coding/pipeline";
import { DEFAULT_PROFILE_NAME } from "../config/model-profiles";

/** Parsed arguments from the command line. */
export interface CliArgs {
  readonly pipelineName: string;
  readonly workspace: string;
  readonly input: string;
  /** Profile name override. Falls back to AI_CODING_MODEL_PROFILE env var, then the default. */
  readonly profileName: string;
}

const USAGE = `Usage: bun run pipeline <name> <workspace> [--input "request text"] [--profile <name>]

Pipeline names:
  dev-cycle        TypeScript: plan → implement → write-files → test
  rust-dev-cycle   Rust: plan → implement → write-files → fmt → clippy → test → coverage
  cmake-dev-cycle  C++: plan → implement → write-files → configure → build → test
  scaffold-rust    Rust: cargo init + generate flake.nix
  scaffold-cpp     C++: generate CMakeLists.txt + src/main.cpp + flake.nix

Profile names:
  copilot-default  All roles → github-copilot/claude-sonnet-4.6 (default)

Examples:
  bun run pipeline scaffold-rust /tmp/my-rust-project
  bun run pipeline scaffold-cpp /tmp/my-cpp-project
  bun run pipeline dev-cycle ./my-project --input "Add error handling to the parser"
  bun run pipeline dev-cycle ./my-project --profile copilot-default --input "Add tests"`;

/**
 * Parse CLI arguments from an argv array (excluding the bun/script prefix).
 *
 * Expected format:
 *   <pipelineName> <workspace> [--input "..."] [--profile <name>]
 *
 * Profile precedence: --profile flag > AI_CODING_MODEL_PROFILE env var > default.
 *
 * @param argv - Raw argument list, typically process.argv.slice(2).
 */
export function parseArgs(argv: readonly string[]): Result<CliArgs> {
  const args = [...argv];

  const pipelineName = args.shift();
  if (!pipelineName) {
    return { ok: false, error: new Error(`Missing pipeline name.\n\n${USAGE}`) };
  }

  const workspace = args.shift();
  if (!workspace) {
    return { ok: false, error: new Error(`Missing workspace path.\n\n${USAGE}`) };
  }

  let input = "";
  const inputFlagIndex = args.indexOf("--input");
  if (inputFlagIndex !== -1) {
    const value = args[inputFlagIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        ok: false,
        error: new Error('--input flag requires a value, e.g. --input "Add tests"'),
      };
    }
    input = value;
  }

  let profileName = process.env.AI_CODING_MODEL_PROFILE ?? DEFAULT_PROFILE_NAME;
  const profileFlagIndex = args.indexOf("--profile");
  if (profileFlagIndex !== -1) {
    const value = args[profileFlagIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      return {
        ok: false,
        error: new Error("--profile flag requires a value, e.g. --profile copilot-default"),
      };
    }
    profileName = value;
  }

  return { ok: true, value: { pipelineName, workspace, input, profileName } };
}

/** Return the usage string for display in error messages or --help. */
export function getUsage(): string {
  return USAGE;
}
