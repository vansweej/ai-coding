# Decision Brief: Token-Usage Harvester

> Captured: 2026-07-15
> Status: Ready for planning
> Origin: Stress-test of `aios.md` session-identity mechanism

---

## Feature

A read-only **token-usage harvester** that reads OpenCode and Claude Code's
existing on-disk session data and reports where tokens are spent — by model,
project, session, and cache tier. A standalone Rust binary, independent of
cerebrum and the AI-OS roadmap.

---

## Key Decisions Made

- **Language: Rust, standalone binary.**
  A `cargo build --release` binary with no runtime dependency matches the
  tool's portability goal (separate repo, runs anywhere). The strict type
  system and the heavy-gates culture are well-aimed at the tool's core risk:
  silent misparsing that quietly undercounts tokens. The standard `--release`
  binary is the entire distribution story.

- **Strict-loud-first via `#[serde(deny_unknown_fields)]`.**
  The primary goal during early development is *building experience with the
  OpenCode and Claude Code data models*, not just collecting numbers. Strict
  deserialization with `deny_unknown_fields` on every record struct means any
  key that hasn't been explicitly modelled stops the parse. This turns schema
  gaps into learning prompts rather than silent drops. Lenient/batch mode is
  the later path, not the default.

- **Two-layer parse.**
  Layer 1 deserializes into a **permissive envelope** using `Option<T>` and
  `#[serde(default)]` — just enough to extract the record type and the
  cockpit-version tag (`version` field in Claude Code records). Layer 2
  deserializes the record body strictly, with `deny_unknown_fields`. This
  keeps version-routing cheap and ensures every failure names exactly which
  record struct rejected the input, not just "JSON error."

- **Failures are navigational, not opaque.**
  On a strict parse failure the tool emits: source file path, line number,
  and the record's `version` tag. This turns each failure into a schema-map
  entry: "Claude Code 2.1.159 emits a field my struct doesn't know about."
  Over time this builds a version-keyed schema catalog rather than a pile of
  stack traces.

- **`--strict` / `--lenient` flag.**
  Strict is the default while learning the data models. Lenient mode (skip
  failed records, emit a `dropped_records` count in the report footer) is
  available for when the goal shifts from *understanding* to *daily use*.
  Same parser, one flag — no rewrite required.

- **Session identity is a non-problem and is dropped.**
  Isolated Synapse + shared Cortex already exists for free via
  stdio-per-process + shared LanceDB (`cerebrum-memory.ts:39,43`, `:257`).
  No failures have ever been observed.

- **The shared cerebrum daemon is not built for this goal.**
  It would destroy the free isolation property and force session ids, scoped
  `end_session`, union queries, and an orphan reaper — all to solve nothing
  currently broken.

- **The ledger's data does not flow through cerebrum or the orchestrator.**
  Tokens are discarded at `copilot-dispatcher.ts:62-69`; `ModelDispatcher
  .dispatch` returns `Result<string>`; `AIResponse` (`event-types.ts:36`) has
  no token field. Daily usage runs through the cockpits, not this repo.

- **The data already exists on disk:**
  - Claude Code: `~/.claude/projects/<proj>/<session>.jsonl` — per-message
    `usage{input_tokens, output_tokens, cache_creation_input_tokens,
    cache_read_input_tokens}`, `model`, `timestamp`, `cwd`, `gitBranch`,
    `sessionId`, `version`.
  - OpenCode: `~/.local/share/opencode/opencode.db` (SQLite) +
    `storage/session_diff/ses_*.json` (137+ sessions present on first
    inspection).

- **The JSONL sink schema is the public API.**
  The normalized row shape is the only contract a future AIOS coupling layer
  binds to. Version it from row one (`schema: 1`) so an AIOS reader written
  months later doesn't break on added columns. The sink lives at a stable,
  documented path (e.g. `~/.local/share/token-harvester/ledger.jsonl`).

- **Separate GitHub repo.**
  This is a standalone tool with no code imports from the ai-coding monorepo.
  The only coupling to the future AIOS is the JSONL sink — a file-format
  contract, not a code dependency. The arrow stays healthy: AIOS depends on
  the harvester's output; the harvester never depends on the AIOS.

---

## Open Questions

1. **OpenCode read path:** query `opencode.db` directly (authoritative, but
   needs read-only open + WAL care while OpenCode runs) vs parse
   `session_diff/*.json` (fragile if schema changes). Needs a ½-day spike to
   confirm token fields in the DB schema before planning the reader.

2. **Cost vs volume:** on a flat-rate Copilot subscription, dollar cost is
   largely meaningless. Confirm the target metric is **token volume and
   distribution**, not $.

3. **Batch vs continuous:** on-demand `token-report` vs a tailing daemon.
   Batch-on-demand first; daemon only if the batch report proves insufficient.

4. **Cache-tier breakdown:** should the report separate `cache_read_input_tokens`
   from fresh `input_tokens`? Strong signal for context bloat — likely the
   most actionable single insight.

5. **Attribution depth:** `model/tokens/project/session` are free; `skill` is
   partially recoverable from Claude `skill_listing` and subagent spawn
   records; **`outcome` is recorded nowhere.** Confirm a token/model/project
   dashboard is sufficient before attempting skill attribution.

---

## Rejected Alternatives

- **Shared cerebrum daemon + session identity** — solves no observed problem;
  creates the `end_session` landmine it claims to defuse; wrong data domain
  (memory ops, not tokens). Full argument in `aios.md`.

- **Instrumenting `orchestrate()` in the ai-coding repo** — only captures
  ai-coding pipeline calls, not daily OpenCode/Claude Code usage (the actual
  target).

- **OpenTelemetry push pipeline** — heavier moving parts than reading files
  already on disk; revisit only if live streaming becomes necessary.

- **TypeScript / Bun in the monorepo** — co-location would be physical, not
  logical; the tool shares no code with the ai-coding monorepo. Rust static
  binary better matches portability goal and trust requirements.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Format drift (JSONL version changes) | High | Low | `deny_unknown_fields` + version tag on failure output; strict mode surfaces drift immediately |
| `deny_unknown_fields` too aggressive while learning | Medium | Low | `--lenient` flag available from day one; loosen per-struct as schema is understood |
| OpenCode DB concurrency | Medium | Low | Open read-only; respect WAL mode; never write |
| Two-source normalization edge cases | Medium | Medium | Spike both readers before committing to a row shape |
| Metric meaninglessness ($ on flat plan) | Low | Medium | Report token volume; omit $ unless billing data is available |
| Scope creep back into AI-OS | Low | Medium | Keep it a decoupled utility; coupling lives in the sink file, not the code |

---

## Recommended Next Steps

1. **Spike the two readers (½ day):** open `opencode.db` read-only and confirm
   which table/columns hold per-message token counts. Finalize the Claude JSONL
   parse against the real files in `~/.claude/projects/`. Choose DB vs JSON for
   OpenCode. This spike decides the most uncertain part of the design before any
   planning goes deep.

2. **Define one normalized row + a JSONL sink.** Minimum shape:
   ```
   { schema: 1, ts, cockpit, project, session, model,
     input, output, cache_read, cache_creation, skill? }
   ```
   Sink path: `~/.local/share/token-harvester/ledger.jsonl`.

3. **Ship a one-shot `token-report` CLI first.** Aggregate by day / project /
   model, with cache-read vs fresh-input split. Default `--strict`. Defer any
   daemon or live-tail mode until the batch report proves useful.

4. **Keep cerebrum and the AI-OS roadmap untouched.** This tool stands alone.
   When the AI-OS foundation is eventually built, the harvester's JSONL sink
   becomes one of its inputs — not the other way around.
