import type { Result } from "@ai-coding/pipeline";

/** Parsed arguments from the command line. */
export interface CliArgs {
  readonly pipelineName: string;
  readonly workspace: string;
  readonly input: string;
}

const USAGE = `Usage: bun run pipeline <name> <workspace> [--input "request text"]

Pipeline names:
  dev-cycle        TypeScript: plan → implement → test
  rust-dev-cycle   Rust: plan → implement → fmt → clippy → test → coverage
  cmake-dev-cycle  C++: plan → implement → configure → build → test
  scaffold-rust    Rust: cargo init + generate flake.nix
  scaffold-cpp     C++: generate CMakeLists.txt + src/main.cpp + flake.nix

Examples:
  bun run pipeline scaffold-rust /tmp/my-rust-project
  bun run pipeline scaffold-cpp /tmp/my-cpp-project
  bun run pipeline dev-cycle ./my-project --input "Add error handling to the parser"`;

/**
 * Parse CLI arguments from an argv array (excluding the bun/script prefix).
 *
 * Expected format:
 *   <pipelineName> <workspace> [--input "..."]
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

  return { ok: true, value: { pipelineName, workspace, input } };
}

/** Return the usage string for display in error messages or --help. */
export function getUsage(): string {
  return USAGE;
}
