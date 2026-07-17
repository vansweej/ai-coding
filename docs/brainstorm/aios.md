# AI OS — Cerebrum-Centered Architecture Brief

> Captured: 2026-07-15
> Status: Foundation chosen, two tracks mapped, detailed planning deferred pending session-identity validation

---

## Idea

A self-built "AI OS" centered on **cerebrum as a single shared-brain server** that every CLI cockpit (OpenCode, Claude Code) plugs into — with memory and orchestration maturing along two evidence-driven tracks.

---

## Context

The user runs daily coding work through OpenCode and Claude Code, backed by:
- **Specialized agents** — a large roster of skills
- **Athenaeum** — knowledge base
- **Cerebrum** — two-tier memory (Synapse = short-term, Cortex = long-term)
- **Hermes** — deterministic repo automation (dependabot autopilot)

**Hard constraints — both are non-negotiable:**
1. Everything is hand-built for the learning experience; downloading a turnkey AIOS is explicitly rejected as un-educational.
2. Ranking metric: **learning-value-per-line-of-code** — every piece must stay buildable in a weekend and understandable forever.

---

## Explored Directions

| # | Name | Status |
|---|------|--------|
| — | Sensory/Reflex layer | Resolved: Hermes (Archetype A, Reflex Arc), parked |
| 0 | Context Bridge / shared brain | **Chosen as the foundation** |
| 1 | Session Ledger | Queued — the hinge |
| 2 | Skill/Agent Eval Harness | Queued — later |
| 3 | Consolidation Daemon | Queued — Track A |
| 4 | Kernel / Orchestrator | Big goal, deferred |
| 5 | Policy / Cost Governor | Deferred until autonomy increases |
| 6 | Skill Router | Queued — Track B, ramp-up to #4 |
| 7 | Forgetting / Memory GC | Queued — Track A |

---

## Chosen Direction

**Cerebrum as a single shared-instance server**, with:
- **Cortex (long-term)** — shared globally across all cockpits
- **Synapse (short-term)** — isolated per cockpit / session

This mirrors how human memory works: private working memory, shared consolidated knowledge. Two terminals think their own thoughts; what proves worth keeping graduates into a commons they both draw on.

### Why this model

- Delivers cross-cockpit continuity without terminals stepping on each other
- Defuses the `end_session` landmine: wrapping up in one cockpit can no longer wipe a sibling's short-term memory
- Architecture shift from library to *service*: one owner of state, many thin MCP clients — a foundational client/server systems lesson
- Three downstream projects (ledger, consolidation, forgetting) fall out cheaply once all reads/writes flow through one server

### Read / write model

```
  READ   =  own Synapse slice  ∪  shared Cortex
  WRITE  =  own Synapse slice only
  END    =  clear own Synapse slice, promote salient memories → shared Cortex
```

### Architecture sketch

```
   ┌─────────────── cerebrum server (single instance) ──────────────┐
   │                                                                  │
   │   CORTEX  (long-term)   ──── SHARED ────  global commons        │
   │      ▲ promote on end_session                                    │
   │   ┌──┴──────────┬─────────────────┐                              │
   │  Synapse       Synapse           Synapse    ──── ISOLATED ────   │
   │  session:oc-1  session:cc-1      session:cc-2                    │
   └──────┬──────────────┬────────────────┬───────────────────────────┘
        OpenCode      Claude Code      Claude Code #2
```

---

## The Roadmap

### Foundation (prerequisite for everything)

```
  Shared cerebrum server  +  redesigned end_session (session-scoped)
```

This is the enabler. Do this first. Nothing else is sequenced correctly without it.

### Track A — Memory Matures

```
  #1 Ledger  →  #3 Consolidation  →  #7 Forgetting
  (observe)      (compress)            (decay)
```

- **#1 Session Ledger** — append-only JSONL log: `{timestamp, cockpit, skill, task, tokens, outcome}`. ~50 lines, ~80% of observability value. Falls nearly free from the shared server: every call flows through one place.
- **#3 Consolidation Daemon** — a `cerebrum-sleep` script: pull the day's Synapse, cluster, LLM-compress episodic→semantic, cross-link to athenaeum, propose Cortex promotions. Upgrades the current salience-threshold `end_session` into actual reasoning.
- **#7 Forgetting / Memory GC** — salience decay over time, flagging of stale or contradictory Cortex entries, pruning proposals. Memory that only grows eventually poisons recall. The mirror image of the consolidation daemon.

### Track B — Orchestration Emerges

```
  #6 Skill Router  →  #4 Kernel
  (suggest)            (route + hand off)
```

- **#6 Skill Router** — a classifier that reads a task and *suggests* which skill(s) to load. Start as a suggester you confirm, not an autopilot. Watch it via the ledger (#1), see where it's right and wrong.
- **#4 Kernel / Orchestrator** — agents calling agents, a shared scratchpad (blackboard), context hand-off protocol. By the time you build this, months of ledger data will tell you exactly what it needs to do. Let it earn its way into existence.

### The Hinge

**The Session Ledger (#1) is not just Track A's first step — it feeds both tracks.**
- Track A needs it to know what to consolidate and what has gone stale.
- Track B needs its usage data so the router and kernel emerge from evidence, not imagination.

The ledger is therefore the **correct first build** after the shared server. Not because it's small (though it is), but because it de-risks every later decision by replacing guesses with your own usage data.

```
                    ┌─ SHARED BRAIN (cerebrum as one server) ─┐
                    │         your chosen foundation           │
                    └────────────────┬────────────────────────┘
                                     │
                            #1 SESSION LEDGER
                            (the hinge — feeds both)
                                     │
             ┌───────────────────────┴───────────────────────┐
             │                                                 │
      TRACK A: MEMORY MATURES                   TRACK B: ORCHESTRATION EMERGES
             │                                                 │
      #3 Consolidation (compress)                    #6 Router  (suggest)
             │                                                 │
      #7 Forgetting (decay)                          #4 Kernel  (route + hand off)
```

---

## Open Questions

These must be resolved before or during the foundational build. They are listed in order of criticality.

**1. Session identity (the crux)**
How does the shared server know which Synapse slice a call belongs to? Three options, each a different lesson:
- **Server-assigned on connect** — each MCP connection mints a session id. Cleanest; depends on whether OpenCode/Claude Code expose a stable per-connection handle.
- **Client-supplied** — each cockpit generates a session id at launch (env var, PID, timestamp). Dead simple, fully in your control; relies on cockpit config to inject it.
- **Lean on existing scopes** — use cerebrum's `agent:`/`session:` scopes, be disciplined about passing them. Least new code, most manual.

*Recommendation: stress-test this with `spar` first — it's the assumption the whole foundation rests on.*

**2. Shared file vs. shared server**
"One instance" implies a server process (option B), not two processes fighting over one SQLite file (option A). SQLite locking under concurrent writes = real pain. Needs confirming against concurrency reality before committing.

**3. Orphan slices**
A crashed CLI leaves a Synapse slice with no `end_session`. Needs a TTL or a reaper — a small but genuine distributed-systems lesson (cleanup of abandoned state).

**4. Forgetting policy (#7)**
Decay curve and contradiction-detection are subtle. Forgetting the wrong thing is costly. Design fuzziness is intentional — let real usage data (from #1) inform the policy before designing it.

**5. Consolidation design (#3)**
Clustering + compression heuristics are the most open-ended part. MemGPT/Letta and Generative Agents (see prior art) are the reference models; adapt rather than invent.

---

## Prior Art

- **AIOS: LLM Agent Operating System** — Mei et al., COLM 2025. Kernel services: scheduling, context management, memory, storage, access control. Reports ~2.1× speedup from scheduling alone. https://arxiv.org/abs/2403.16971
- **MemGPT / Letta** — LLM-as-OS managing its own tiered memory hierarchy with paging. Natural model for the shared-brain architecture. https://arxiv.org/abs/2310.08560
- **Generative Agents** — Park et al. Explicit *reflection* step synthesizes higher-level memories from observations. The direct model for the Consolidation Daemon (#3). https://arxiv.org/abs/2304.03442

---

## Recommended Next Steps

1. **`spar` — stress-test session identity first.** Is per-connection identity actually available from both OpenCode and Claude Code, or does the client-supplied-id fallback become mandatory? This is the one assumption that could reshape the whole foundation.

2. **`plan` — scope the foundational build.** Shared cerebrum server + Session Ledger (#1) as a single deliverable. Include redesign of `end_session` to be session-scoped. Orphan-slice TTL/reaper as a stretch goal. Defer Track A/B detail until the ledger produces real usage data.

3. **Defer everything else.** #3, #6, #7, #4 — all after the foundation is running and the ledger has data. Let evidence drive the next round of planning.
