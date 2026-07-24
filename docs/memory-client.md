# Cerebrum Memory Client Integration

The Cerebrum MCP server provides a two-tier memory system (Synapse + Cortex) that enables
the `rust-plan-cycle` pipeline to track phase progress, store implementation context, and
support resumable failures.

## Table of Contents

1. [Overview](#overview)
2. [Two-Tier Memory System](#two-tier-memory-system)
3. [Memory Operations](#memory-operations)
4. [Memory Scopes](#memory-scopes)
5. [Integration with rust-plan-cycle](#integration-with-rust-plan-cycle)
6. [Salience and Prioritization](#salience-and-prioritization)
7. [Optional Integration](#optional-integration)
8. [Troubleshooting](#troubleshooting)

---

## Overview

### What is Cerebrum?

Cerebrum is an MCP (Model Context Protocol) server that provides a two-tier memory system
for AI agents. It enables:

- **Short-term memory (Synapse)**: Fast, in-memory storage for the current session
- **Long-term memory (Cortex)**: Persistent LanceDB storage across sessions
- **Semantic search**: Find memories by semantic similarity, not just exact match
- **Scope isolation**: Memories can be scoped to global, user, agent, or session
- **Salience-based prioritization**: Important memories are marked with higher salience

### Why Use Memory in rust-plan-cycle?

The `rust-plan-cycle` pipeline uses memory to:

1. **Track phase progress**: Store which phases have been completed
2. **Store implementation context**: Save LLM responses and diagnostics for later reference
3. **Support resumability**: Enable the pipeline to understand prior progress and continue intelligently
4. **Improve escalation**: Provide context to Copilot when escalating from local retries
5. **Enable learning**: Store successful patterns for future similar tasks

---

## Two-Tier Memory System

### Synapse (Short-Term)

- **Storage**: In-memory (fast)
- **Lifetime**: Current session only
- **Use case**: Immediate context during pipeline execution
- **Capacity**: Limited by available RAM
- **Latency**: Microseconds

### Cortex (Long-Term)

- **Storage**: LanceDB (persistent)
- **Lifetime**: Across sessions
- **Use case**: Historical context, learning, resumability
- **Capacity**: Limited by disk space
- **Latency**: Milliseconds

### Promotion

Memories can be promoted from Synapse to Cortex:

```typescript
// Store in Synapse (short-term)
await memory.remember("Phase 1 completed", 0.9);

// Later, promote to Cortex (long-term)
await memory.memorize(memoryId);

// Or auto-promote at session end
await memory.endSession(0.7); // promote all memories with salience >= 0.7
```

---

## Memory Operations

### 1. Remember (Store in Synapse)

Store a memory in short-term storage:

```typescript
const result = await memory.remember(
  content: string,
  salience?: number,  // 0.0-1.0, default 0.5
  scope?: string      // "global", "user:name", "agent:id", "session:id"
);
```

**Example**:

```typescript
await memory.remember(
  JSON.stringify({
    phaseNumber: 1,
    title: "Create auth module",
    commitMessage: "feat: add auth module",
    stepsCount: 2,
    startedAt: Date.now()
  }),
  0.8,  // high salience
  "global"
);
```

### 2. Recall (Search Synapse + Cortex)

Search memories by semantic similarity:

```typescript
const result = await memory.recall(
  query: string,
  limit?: number  // default 10
);
```

**Example**:

```typescript
const memories = await memory.recall("phase 1 completion status", 5);
// Returns up to 5 most relevant memories
```

### 3. Recall by Scope (Filtered Search)

Search memories within a specific scope:

```typescript
const result = await memory.recallByScope(
  query: string,
  scope: string,  // "global", "user:name", "agent:id", "session:id"
  limit?: number
);
```

**Example**:

```typescript
const agentMemories = await memory.recallByScope(
  "phase completion",
  "agent:debugger",
  10
);
```

### 4. Memorize (Promote to Cortex)

Promote a memory from Synapse to Cortex:

```typescript
const result = await memory.memorize(memoryId: string);
```

**Example**:

```typescript
// Store in Synapse
const stored = await memory.remember("Important context", 0.9);
if (stored.ok) {
  // Later, promote to Cortex
  await memory.memorize(stored.value);
}
```

### 5. Forget (Delete)

Delete a memory from both Synapse and Cortex:

```typescript
const result = await memory.forget(memoryId: string);
```

**Example**:

```typescript
await memory.forget(memoryId);
```

### 6. End Session (Auto-Promote)

Promote all memories above a salience threshold at session end:

```typescript
const result = await memory.endSession(
  promotionThreshold?: number  // 0.0-1.0, default 0.7
);
```

**Example**:

```typescript
// At the end of the pipeline execution
await memory.endSession(0.7);
// All memories with salience >= 0.7 are promoted to Cortex
```

---

## Memory Scopes

### Global Scope

Shared across all agents and sessions:

```typescript
await memory.remember("Shared context", 0.5, "global");
```

**Use case**: Feature-level context, shared learnings

### User Scope

Isolated per user:

```typescript
await memory.remember("User-specific context", 0.5, "user:alice");
```

**Use case**: User preferences, user-specific learnings

### Agent Scope

Isolated per agent:

```typescript
await memory.remember("Agent-specific context", 0.5, "agent:debugger");
```

**Use case**: Agent-specific strategies, agent learnings

### Session Scope

Isolated per session:

```typescript
await memory.remember("Session-specific context", 0.5, "session:abc123");
```

**Use case**: Temporary context, session-local state

---

## Integration with rust-plan-cycle

### Phase Context Storage

At the start of each phase:

```typescript
await memory.remember(
  JSON.stringify({
    phaseNumber: phase.number,
    title: phase.title,
    commitMessage: phase.commitMessage,
    stepsCount: phase.steps.length,
    startedAt: Date.now()
  }),
  0.8,  // high salience
  "global"
);
```

### Implementation Response Storage

After each step implementation:

```typescript
await memory.remember(
  JSON.stringify({
    action: "edit",
    model: "gemma4:26b",
    mode: "agentic",
    prompt: originalPrompt,
    response: modelResponse,
    timestamp: Date.now()
  }),
  0.6,  // medium salience
  "global"
);
```

### Phase Completion Storage

After successful phase commit:

```typescript
await memory.remember(
  JSON.stringify({
    phaseNumber: phase.number,
    status: "completed",
    stepsCompleted: phase.steps.length,
    completedAt: Date.now()
  }),
  0.9,  // highest salience
  "global"
);
```

### Resume Detection

During resume, the pipeline can query memory:

```typescript
const completedPhases = await memory.recall(
  "phase completion status",
  100
);
// Parse responses to find the last completed phase number
```

---

## Salience and Prioritization

### Salience Scale

- **0.0-0.3**: Low priority (temporary, debug info)
- **0.3-0.6**: Medium priority (normal context)
- **0.6-0.8**: High priority (important context)
- **0.8-1.0**: Critical priority (essential context)

### rust-plan-cycle Salience Levels

| Memory Type | Salience | Reason |
|-------------|----------|--------|
| Phase context | 0.8 | Important for understanding phase progress |
| Implementation response | 0.6 | Useful for diagnostics and learning |
| Phase completion | 0.9 | Critical for resumability |
| Orchestrator response | 0.6 | Context for decision-making |

### Auto-Promotion Threshold

At session end, memories with salience >= 0.7 are promoted to Cortex:

```typescript
await memory.endSession(0.7);
// Phase context (0.8) and completion (0.9) are promoted
// Implementation responses (0.6) are not promoted
```

---

## Optional Integration

### Graceful Degradation

Memory is **optional**. If the Cerebrum server is unavailable:

1. The pipeline continues normally
2. No error is raised
3. Phase context is not stored
4. Resume still works via git trailers

### Checking Memory Availability

```typescript
if (config.memory) {
  // Memory is available
  await config.memory.remember("context", 0.8);
} else {
  // Memory is not available, continue without it
}
```

### Enabling Memory

To enable memory in the orchestrator config:

```typescript
import { CerebrumMemory } from "./cerebrum-memory";

const memory = new CerebrumMemory();
const config: OrchestratorConfig = {
  profile: LOCAL_PROFILE,
  dispatchers: { "gemma4:26b": dispatcher },
  memory,  // Enable memory
};
```

---

## Troubleshooting

### "Memory client is not available"

**Cause**: The Cerebrum MCP server is not running or not configured.

**Fix**:

1. Check if Cerebrum is running:
   ```bash
   ps aux | grep cerebrum
   ```

2. Start Cerebrum if needed:
   ```bash
   cerebrum-mcp
   ```

3. Or disable memory integration (pipeline continues without it)

### "Memory operation failed: timeout"

**Cause**: The Cerebrum server is slow or unresponsive.

**Fix**:

1. Check Cerebrum logs for errors
2. Restart the Cerebrum server
3. Or disable memory integration

### "Memory operation failed: invalid scope"

**Cause**: An invalid scope was used (not global, user:*, agent:*, or session:*).

**Fix**: Use a valid scope:

```typescript
// Valid scopes
await memory.remember("context", 0.5, "global");
await memory.remember("context", 0.5, "user:alice");
await memory.remember("context", 0.5, "agent:debugger");
await memory.remember("context", 0.5, "session:abc123");
```

### "Memory recall returns no results"

**Cause**: No memories match the query, or all memories are in Cortex (long-term).

**Fix**:

1. Check if memories were stored with `remember()`
2. Use `endSession()` to promote memories to Cortex
3. Or use a different query that matches stored memories

---

## See Also

- [`README.md`](../README.md) — Quick start and pipeline overview
- [`docs/plan-cycle.md`](plan-cycle.md) — plan-cycle comprehensive guide
- [`docs/resume-workflow.md`](resume-workflow.md) — Deep dive into resume mechanism
