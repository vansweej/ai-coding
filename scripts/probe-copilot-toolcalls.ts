/* v8 ignore start */
/**
 * EMPIRICAL PROBE (one-shot diagnostic, not shipped runtime code).
 *
 * Sends a single OpenAI-shaped chat/completions request through the exact
 * Copilot path CopilotDispatcher uses -- durable GITHUB_COPILOT_TOKEN sent
 * DIRECTLY as the Bearer credential (no copilot_internal/v2/token exchange,
 * which is WAF-blocked for opencode-minted tokens), the same honest
 * User-Agent, and the same X-GitHub-Api-Version header -- with a forced
 * `tools`/`tool_choice` body using PATCH_OPS_JSON_SCHEMA as the function's
 * `parameters`. It prints the raw response and specifically whether
 * `choices[0].message.tool_calls` is present and its `arguments` JSON string
 * parses to our schema.
 *
 * This answers Plan B's open fork empirically: does Copilot's proxy honor
 * forced tool_calls for our schema at all? The result gates the rest of
 * Plan B (see docs/plan-structured-patch-b.md and docs/adr/0001-copilot-structured-patch.md).
 *
 * Run with: GITHUB_COPILOT_TOKEN=<token> bun run scripts/probe-copilot-toolcalls.ts
 */
import { PATCH_OPS_JSON_SCHEMA, PATCH_TOOL_NAME } from "@ai-coding/shared";

import { parsePatchOps } from "../ai-system/core/orchestrator/patch-contract";

const COPILOT_CHAT_URL = "https://api.githubcopilot.com/chat/completions";

async function main(): Promise<void> {
  const token = process.env.GITHUB_COPILOT_TOKEN;
  if (!token) {
    console.error("GITHUB_COPILOT_TOKEN is not set. Export it and retry.");
    process.exit(1);
  }

  const body = {
    model: "claude-sonnet-4.6",
    messages: [
      {
        role: "user",
        content: 'Create a file named "hello.ts" containing exactly: export const hello = "world";',
      },
    ],
    stream: false,
    tools: [
      {
        type: "function",
        function: {
          name: PATCH_TOOL_NAME,
          description:
            "Emit the complete set of file create/edit/move operations for this phase as structured data.",
          parameters: PATCH_OPS_JSON_SCHEMA,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: PATCH_TOOL_NAME } },
  };

  console.log("--- Request body ---");
  console.log(JSON.stringify(body, null, 2));

  const response = await fetch(COPILOT_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "ai-coding-os/1.0.0",
      "X-GitHub-Api-Version": "2026-06-01",
      "Openai-Intent": "conversation-edits",
      "x-initiator": "user",
    },
    body: JSON.stringify(body),
  });

  console.log(`\n--- HTTP status: ${response.status} ---`);

  if (!response.ok) {
    console.log(await response.text());
    console.log("\nPROBE RESULT: FAIL (non-2xx response)");
    process.exit(1);
  }

  const data = (await response.json()) as {
    choices?: ReadonlyArray<{
      message?: {
        content?: string;
        tool_calls?: ReadonlyArray<{ function?: { name?: string; arguments?: string } }>;
      };
    }>;
  };

  console.log("\n--- Raw response ---");
  console.log(JSON.stringify(data, null, 2));

  const toolCalls = data.choices?.[0]?.message?.tool_calls;
  console.log(`\n--- tool_calls present: ${toolCalls !== undefined && toolCalls.length > 0} ---`);

  if (!toolCalls || toolCalls.length === 0) {
    console.log("\nPROBE RESULT: FAIL -- no tool_calls in response.");
    console.log("Copilot's proxy does not honor forced tool_calls for this schema.");
    console.log("Plan B stays gated: Copilot remains text-mode. Phase 2 must NOT proceed.");
    process.exit(1);
  }

  const call = toolCalls.find((c) => c.function?.name === PATCH_TOOL_NAME);
  if (!call || call.function?.arguments === undefined) {
    console.log(
      `\nPROBE RESULT: FAIL -- tool_calls present but no "${PATCH_TOOL_NAME}" call found.`,
    );
    process.exit(1);
  }

  console.log(`\n--- Raw arguments string ---\n${call.function.arguments}`);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(call.function.arguments);
  } catch (err) {
    console.log(`\nPROBE RESULT: FAIL -- arguments is not valid JSON: ${String(err)}`);
    process.exit(1);
  }

  const parsed = parsePatchOps(parsedJson);
  if (!parsed.ok) {
    console.log(
      `\nPROBE RESULT: FAIL -- arguments JSON does not match our schema: ${parsed.error.message}`,
    );
    process.exit(1);
  }

  console.log(`\n--- Parsed PatchOp[] ---\n${JSON.stringify(parsed.value, null, 2)}`);
  console.log(
    "\nPROBE RESULT: PASS -- Copilot honored forced tool_calls and returned schema-valid arguments.",
  );
}

await main();
/* v8 ignore stop */
