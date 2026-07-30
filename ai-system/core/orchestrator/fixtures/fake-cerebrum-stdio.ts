#!/usr/bin/env bun
/**
 * Minimal fake cerebrum MCP stdio server for cerebrum-plan-source tests.
 *
 * Speaks just enough JSON-RPC to satisfy StdioRpcClient's handshake and a
 * single recall_by_scope tool call, returning canned results from the
 * FAKE_CEREBRUM_RESULTS env var (inherited from the spawning test process,
 * since resolvePlanRef's spawn passes no argv).
 */
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let msg: { id?: number; method?: string };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    continue;
  }

  if (msg.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-cerebrum", version: "0.0.0" },
        },
      })}\n`,
    );
  } else if (msg.method === "notifications/initialized") {
    // No response expected for notifications.
  } else if (msg.method === "tools/call") {
    const results = JSON.parse(process.env.FAKE_CEREBRUM_RESULTS ?? "[]");
    const payload = { success: true, count: results.length, results };
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      })}\n`,
    );
  }
}
