import { spawn } from "node:child_process";

import type { Result } from "@ai-coding/shared";

/**
 * Minimal shape of a spawned child process this client actually uses.
 *
 * Narrowed locally rather than typed via `ChildProcessByStdio` directly:
 * this project's nested bun-managed `@types/node` resolution has two
 * conflicting versions installed, which breaks that generic's EventEmitter
 * overloads (`.on` reported as missing) even though the runtime shape is
 * correct. This interface describes exactly the surface used below.
 */
interface SpawnedChild {
  readonly stdin: {
    write(chunk: string, cb?: (err?: Error | null) => void): void;
    end(): void;
  };
  readonly stdout: {
    on(event: "data", listener: (chunk: Buffer) => void): void;
  };
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(): void;
}

/**
 * A minimal newline-delimited JSON-RPC 2.0 client over stdio, speaking just
 * enough of the Model Context Protocol handshake to call a single tool.
 *
 * Deliberately hand-rolled rather than depending on
 * `@modelcontextprotocol/sdk`: this process only ever needs to call one tool
 * (`recall_by_scope`) once per run, so a full client SDK is unwarranted
 * dependency weight for the plan-cycle CLI's cold-start path.
 */
class StdioRpcClient {
  private readonly child: SpawnedChild;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (msg: JsonRpcResponse) => void; reject: (err: Error) => void }
  >();
  private readonly startupError: Promise<never>;

  constructor(bin: string) {
    this.child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "inherit"],
    }) as unknown as SpawnedChild;
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));

    this.startupError = new Promise((_, reject) => {
      this.child.on("error", (err: Error) => reject(err));
      this.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.pending.size > 0) {
          const reason = signal ? `signal ${signal}` : `exit code ${code}`;
          const err = new Error(`cerebrum process exited unexpectedly (${reason})`);
          for (const { reject: rejectPending } of this.pending.values()) rejectPending(err);
          this.pending.clear();
        }
        reject(new Error("cerebrum process exited"));
      });
    });
    // Prevent an unhandled rejection warning; real awaits race against this.
    this.startupError.catch(() => {});
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) this.handleLine(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // Ignore non-JSON stdout noise; cerebrum's own logs go to stderr, but
      // be defensive rather than crash the whole resolution on a stray line.
      return;
    }
    if (!isJsonRpcResponse(msg)) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    pending.resolve(msg);
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    expectResponse: true,
  ): Promise<JsonRpcResponse>;
  private send(method: string, params: Record<string, unknown>, expectResponse: false): void;
  private send(
    method: string,
    params: Record<string, unknown>,
    expectResponse: boolean,
  ): Promise<JsonRpcResponse> | undefined {
    if (!expectResponse) {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      return;
    }

    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return Promise.race([
      new Promise<JsonRpcResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`cerebrum ${method} timed out after 30s`));
        }, 30_000);
        this.pending.set(id, {
          resolve: (msg) => {
            clearTimeout(timeout);
            resolve(msg);
          },
          reject: (err) => {
            clearTimeout(timeout);
            reject(err);
          },
        });
        this.child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
          if (err) {
            clearTimeout(timeout);
            this.pending.delete(id);
            reject(err);
          }
        });
      }),
      this.startupError,
    ]);
  }

  async initialize(): Promise<void> {
    await this.send(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ai-coding-plan-cycle", version: "0.1.0" },
      },
      true,
    );
    this.send("notifications/initialized", {}, false);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await this.send("tools/call", { name, arguments: args }, true);
    if (response.error) {
      throw new Error(`cerebrum tool '${name}' error: ${response.error.message}`);
    }
    return response.result;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function isJsonRpcResponse(v: unknown): v is JsonRpcResponse {
  return (
    typeof v === "object" &&
    v !== null &&
    "jsonrpc" in v &&
    "id" in v &&
    typeof (v as { id: unknown }).id === "number"
  );
}

/** Shape of a cerebrum `recall_by_scope` tool result's parsed text payload. */
interface RecallByScopeResult {
  readonly results?: ReadonlyArray<{
    readonly content?: string;
    readonly scope?: string;
  }>;
}

/** Extracts the first text content item from an MCP `CallToolResult`. */
function extractText(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || !("content" in raw)) return undefined;
  const content = (raw as { content: unknown }).content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const first = content[0] as { type?: string; text?: string };
  return typeof first.text === "string" ? first.text : undefined;
}

/** Options for {@link resolvePlanRef}. */
export interface ResolvePlanRefOptions {
  /** Absolute path to the cerebrum MCP server binary. */
  readonly cerebrumBin: string;
}

/**
 * Resolves a plan body from cerebrum by its `plan:<planRef>` scope.
 *
 * Uses `exact_scope: true` so the fetch is not crowded out of the result
 * window by unrelated high-salience global memories in the store (the same
 * convention choragos uses on the Rust side to fetch a plan by its exact
 * scope). Returns an Error Result if `cerebrumBin` is unset, the cerebrum
 * process cannot be reached, or no memory with that exact scope is found.
 */
export async function resolvePlanRef(
  planRef: string,
  opts: ResolvePlanRefOptions,
): Promise<Result<string>> {
  if (!opts.cerebrumBin) {
    return {
      ok: false,
      error: new Error(
        "CEREBRUM_BIN is not set; cannot resolve --plan-ref without the cerebrum MCP server binary",
      ),
    };
  }

  const client = new StdioRpcClient(opts.cerebrumBin);
  try {
    await client.initialize();

    const scope = `plan:${planRef}`;
    const raw = await client.callTool("recall_by_scope", {
      query: planRef,
      scope,
      limit: 5,
      exact_scope: true,
    });

    const text = extractText(raw);
    if (text === undefined) {
      return {
        ok: false,
        error: new Error(
          `cerebrum recall_by_scope returned no text content for plan_ref '${planRef}'`,
        ),
      };
    }

    let parsed: RecallByScopeResult;
    try {
      parsed = JSON.parse(text) as RecallByScopeResult;
    } catch (error) {
      return {
        ok: false,
        error: new Error(
          `cerebrum recall_by_scope returned invalid JSON for plan_ref '${planRef}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    }

    const match = parsed.results?.find((r) => r.scope === scope);
    if (!match?.content) {
      return {
        ok: false,
        error: new Error(`no plan found in cerebrum for plan_ref '${planRef}' (scope '${scope}')`),
      };
    }

    return { ok: true, value: match.content };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  } finally {
    client.close();
  }
}
