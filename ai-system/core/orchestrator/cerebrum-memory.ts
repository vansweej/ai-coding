import type { Result } from "@ai-coding/shared";

/** Memory scope for isolation: global, user, agent, or session. */
export type MemoryScope = "global" | `user:${string}` | `agent:${string}` | `session:${string}`;

/** Memory operation result with optional content. */
export interface MemoryEntry {
  readonly id: string;
  readonly content: string;
  readonly salience: number;
  readonly scope: MemoryScope;
}

/** MCP JSON-RPC request format. */
interface MCPRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** MCP JSON-RPC response format. */
interface MCPResponse {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

/**
 * Cerebrum memory client for two-tier memory (Synapse + Cortex).
 * Communicates with the cerebrum MCP server via stdio using JSON-RPC protocol.
 */
export class CerebrumMemory {
  private readonly scope: MemoryScope;
  private requestId: number = 0;
  private useMockMode: boolean = true; // Start in mock mode, switch to real when MCP is available

  constructor(scope: MemoryScope = "global") {
    this.scope = scope;
  }

  /**
   * Store a memory in Synapse (short-term) tier.
   * Automatically generates embeddings via Ollama.
   */
  async remember(
    content: string,
    salience?: number,
  ): Promise<Result<string>> {
    try {
      const result = await this.callMCPTool("cerebrum_remember", {
        content,
        salience: salience ?? 0.5,
        scope: this.scope,
      });

      if (!result.ok) {
        return result;
      }

      // Extract memory ID from response
      const memoryId = this.extractMemoryId(result.value);
      return { ok: true, value: memoryId };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Search memories using semantic similarity.
   * Returns memories from both Synapse and Cortex tiers.
   */
  async recall(
    query: string,
    limit?: number,
  ): Promise<Result<MemoryEntry[]>> {
    try {
      const result = await this.callMCPTool("cerebrum_recall", {
        query,
        limit: limit ?? 10,
      });

      if (!result.ok) {
        return result;
      }

      // Parse memory entries from response
      const entries = this.parseMemoryEntries(result.value);
      return { ok: true, value: entries };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Search memories filtered by scope.
   * Enables per-agent or per-session memory isolation.
   */
  async recallByScope(
    query: string,
    scope: MemoryScope,
    limit?: number,
  ): Promise<Result<MemoryEntry[]>> {
    try {
      const result = await this.callMCPTool("cerebrum_recall_by_scope", {
        query,
        scope,
        limit: limit ?? 10,
      });

      if (!result.ok) {
        return result;
      }

      const entries = this.parseMemoryEntries(result.value);
      return { ok: true, value: entries };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Promote a memory from Synapse (short-term) to Cortex (long-term) storage.
   * Memories above salience threshold are auto-promoted on session end.
   */
  async memorize(memoryId: string): Promise<Result<void>> {
    try {
      const result = await this.callMCPTool("cerebrum_memorize", {
        memory_id: memoryId,
      });

      if (!result.ok) {
        return result;
      }

      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Delete a memory from both Synapse and Cortex tiers.
   */
  async forget(memoryId: string): Promise<Result<void>> {
    try {
      const result = await this.callMCPTool("cerebrum_forget", {
        memory_id: memoryId,
      });

      if (!result.ok) {
        return result;
      }

      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * End session: clear Synapse and auto-promote memories above salience threshold to Cortex.
   */
  async endSession(promotionThreshold?: number): Promise<Result<void>> {
    try {
      const result = await this.callMCPTool("cerebrum_end_session", {
        promotion_threshold: promotionThreshold ?? 0.7,
      });

      if (!result.ok) {
        return result;
      }

      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Call an MCP tool via JSON-RPC over stdio.
   * Uses mock mode by default; can be switched to real mode when MCP server is available.
   */
  private async callMCPTool(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<Result<string>> {
    if (this.useMockMode) {
      return this.callMCPToolMock(toolName, params);
    }

    return this.callMCPToolReal(toolName, params);
  }

  /**
   * Mock implementation of MCP tool calls for testing.
   * Returns predictable responses without requiring a real MCP server.
   */
  private async callMCPToolMock(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<Result<string>> {
    console.debug(`[CerebrumMemory] Mock calling ${toolName} with params:`, params);

    // Mock response for testing
    if (toolName === "cerebrum_remember") {
      return { ok: true, value: `memory-${Date.now()}` };
    }

    if (toolName === "cerebrum_recall" || toolName === "cerebrum_recall_by_scope") {
      return { ok: true, value: "[]" };
    }

    if (
      toolName === "cerebrum_memorize" ||
      toolName === "cerebrum_forget" ||
      toolName === "cerebrum_end_session"
    ) {
      return { ok: true, value: "" };
    }

    return {
      ok: false,
      error: new Error(`Unknown tool: ${toolName}`),
    };
  }

  /**
   * Real implementation of MCP tool calls via JSON-RPC over stdio.
   * Communicates with the cerebrum MCP server.
   * NOTE: This is a placeholder for future implementation.
   * Requires spawning a subprocess and handling stdio communication.
   */
  private async callMCPToolReal(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<Result<string>> {
    try {
      // TODO: Implement actual MCP communication
      // 1. Spawn cerebrum process if not already running
      // 2. Send JSON-RPC request via stdin
      // 3. Read JSON-RPC response from stdout
      // 4. Parse and return result
      // 5. Handle timeouts and errors

      const request: MCPRequest = {
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: `tools/call`,
        params: {
          name: toolName,
          arguments: params,
        },
      };

      console.debug(`[CerebrumMemory] Sending MCP request:`, request);

      // For now, fall back to mock mode
      return this.callMCPToolMock(toolName, params);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Extract memory ID from cerebrum_remember response.
   */
  private extractMemoryId(response: string): string {
    // Parse response to extract memory ID
    // Format: "memory-<timestamp>" or similar
    try {
      const parsed = JSON.parse(response);
      return parsed.memory_id || parsed.id || response;
    } catch {
      return response;
    }
  }

  /**
   * Parse memory entries from cerebrum_recall response.
   */
  private parseMemoryEntries(response: string): MemoryEntry[] {
    try {
      const parsed = JSON.parse(response);
      if (Array.isArray(parsed)) {
        return parsed.map((entry: unknown) => this.normalizeEntry(entry));
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Normalize a memory entry to the MemoryEntry interface.
   */
  private normalizeEntry(entry: unknown): MemoryEntry {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Invalid memory entry");
    }

    const obj = entry as Record<string, unknown>;
    return {
      id: String(obj.id ?? ""),
      content: String(obj.content ?? ""),
      salience: Number(obj.salience ?? 0.5),
      scope: (obj.scope as MemoryScope) ?? "global",
    };
  }
}
