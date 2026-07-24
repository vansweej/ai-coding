import type { Result } from "@ai-coding/pipeline";
import { DEFAULT_PROFILE_NAME } from "../config/model-profiles";

/** Parsed arguments from the command line. */
export interface CliArgs {
  readonly pipelineName: string;
  readonly workspace: string;
  readonly input: string;
  readonly planPath?: string;
  readonly maxRetries?: number;
  /** Profile name override. Falls back to AI_CODING_MODEL_PROFILE env var, then the default. */
  readonly profileName: string;
  /** Default language for plan-cycle phases lacking a Language: directive. */
  readonly language?: string;
}

const USAGE = `Usage: bun run pipeline <name> <workspace> [--plan <file> | --input "request text"] [--max-retries <n>] [--profile <name>] [--language <name>]

Pipeline names:
  plan-cycle       Unattended plan executor: parse plan → per-phase implement → verify/retry → commit; resumable
  rust-plan-cycle  Alias for plan-cycle --language rust
  scaffold-rust    Rust: cargo init + generate flake.nix
  scaffold-cpp     C++: generate CMakeLists.txt + src/main.cpp + flake.nix

Profile names:
  local            All roles → gemma4:26b (local Ollama); no Copilot token required (default)
  hybrid           implementer/tester/debugger → gemma4:26b; fixer → claude-sonnet-4.6
  copilot-default  All roles → github-copilot/claude-sonnet-4.6
  anthropic-sonnet All roles → Anthropic claude-sonnet-5 (native Messages API); requires ANTHROPIC_API_KEY
  bedrock-sonnet   All roles → Claude Sonnet on Amazon Bedrock (InvokeModel API); requires
                   AWS_BEDROCK_INFERENCE_PROFILE_ARN and AWS credentials (e.g. \`aws sso login\`
                   + AWS_PROFILE) resolved via the AWS SDK default provider chain

Language names (--language):
  rust, typescript, python, cpp, haskell, julia, nix, shell

Examples:
  bun run pipeline scaffold-rust /tmp/my-rust-project
  bun run pipeline scaffold-cpp /tmp/my-cpp-project
  bun run pipeline plan-cycle ./my-project --plan ./plans/feature.md --language typescript --profile anthropic-sonnet
  bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md --profile hybrid
  bun run pipeline plan-cycle ./my-project --input "Add tests" --language typescript --max-retries 3`;

function readFlag(args: readonly string[], flag: string): Result<string | undefined> {
  const index = args.indexOf(flag);
  if (index === -1) return { ok: true, value: undefined };
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return { ok: false, error: new Error(`${flag} flag requires a value`) };
  }
  return { ok: true, value };
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

  const rawMaxRetries = readFlag(args, "--max-retries");
  if (!rawMaxRetries.ok) return rawMaxRetries;
  const maxRetries = parseMaxRetries(rawMaxRetries.value);
  if (!maxRetries.ok) return maxRetries;

  const languageResult = readFlag(args, "--language");
  if (!languageResult.ok) return languageResult;
  const language = languageResult.value;

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
      maxRetries: maxRetries.value,
      profileName,
      language,
    },
  };
}

/** Return the usage string for display in error messages or --help. */
export function getUsage(): string {
  return USAGE;
}
