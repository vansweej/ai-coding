import type { Result } from "@ai-coding/pipeline";
import { DEFAULT_PROFILE_NAME } from "../config/model-profiles";
import type { DevCycleLanguageConfig } from "../core/pipeline/definitions/language-configs";

export type CliLanguage = DevCycleLanguageConfig["name"];

/** Parsed arguments from the command line. */
export interface CliArgs {
  readonly pipelineName: string;
  readonly workspace: string;
  readonly input: string;
  readonly planPath?: string;
  readonly language?: CliLanguage;
  readonly maxRetries?: number;
  /** Profile name override. Falls back to AI_CODING_MODEL_PROFILE env var, then the default. */
  readonly profileName: string;
}

const USAGE = `Usage: bun run pipeline <name> <workspace> [--plan <file> | --input "request text"] [--language <typescript|rust|cpp>] [--max-retries <n>] [--profile <name>]

Pipeline names:
  dev-cycle        Unified plan-file implementation pipeline
  rust-dev-cycle   Alias for dev-cycle --language rust
  cmake-dev-cycle  Alias for dev-cycle --language cpp
  scaffold-rust    Rust: cargo init + generate flake.nix
  scaffold-cpp     C++: generate CMakeLists.txt + src/main.cpp + flake.nix

Profile names:
  copilot-default  All roles → github-copilot/claude-sonnet-4.6 (default)
  hybrid           implementer/tester/debugger → gemma4:26b; fixer → claude-sonnet-4.6

Examples:
  bun run pipeline scaffold-rust /tmp/my-rust-project
  bun run pipeline scaffold-cpp /tmp/my-cpp-project
  bun run pipeline dev-cycle ./my-project --plan ./plans/feature.md --profile hybrid
  bun run pipeline dev-cycle ./my-project --language rust --max-retries 3 --input "Add tests"`;

function readFlag(args: readonly string[], flag: string): Result<string | undefined> {
  const index = args.indexOf(flag);
  if (index === -1) return { ok: true, value: undefined };
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return { ok: false, error: new Error(`${flag} flag requires a value`) };
  }
  return { ok: true, value };
}

function parseLanguage(value: string | undefined): Result<CliLanguage | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === "typescript" || value === "rust" || value === "cpp") {
    return { ok: true, value };
  }
  return { ok: false, error: new Error("--language must be one of: typescript, rust, cpp") };
}

function parseMaxRetries(value: string | undefined): Result<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { ok: false, error: new Error("--max-retries must be a non-negative integer") };
  }
  return { ok: true, value: parsed };
}

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

  const inputResult = readFlag(args, "--input");
  if (!inputResult.ok) return inputResult;
  const input = inputResult.value ?? "";

  const planResult = readFlag(args, "--plan");
  if (!planResult.ok) return planResult;
  const planPath = planResult.value;

  const rawLanguage = readFlag(args, "--language");
  if (!rawLanguage.ok) return rawLanguage;
  const parsedLanguage = parseLanguage(rawLanguage.value);
  if (!parsedLanguage.ok) return parsedLanguage;

  const rawMaxRetries = readFlag(args, "--max-retries");
  if (!rawMaxRetries.ok) return rawMaxRetries;
  const maxRetries = parseMaxRetries(rawMaxRetries.value);
  if (!maxRetries.ok) return maxRetries;

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

  return {
    ok: true,
    value: {
      pipelineName,
      workspace,
      input,
      planPath,
      language: parsedLanguage.value,
      maxRetries: maxRetries.value,
      profileName,
    },
  };
}

/** Return the usage string for display in error messages or --help. */
export function getUsage(): string {
  return USAGE;
}
