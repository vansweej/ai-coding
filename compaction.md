# Context Audit Report

**Rating: NEEDS WORK**
**Date:** 2026-05-10

---

## Config Sources Found

| File | Lines |
|------|-------|
| `/Users/Shared/PhilipsDev/ai-coding/opencode.json` | 4 |
| `/Users/janvansweevelt/.config/opencode/opencode.json` | 1 |
| `/Users/Shared/PhilipsDev/ai-coding/AGENTS.md` | **295** |
| `/Users/janvansweevelt/.config/opencode/AGENTS.md` | 13 |
| `CLAUDE.md` (project root) | not found ✅ |
| `~/.claude/CLAUDE.md` | not found ✅ |
| Project `.opencode/agents/` | not found |
| Project `.opencode/skills/` | not found |
| Project `.opencode/tools/` | not found |
| Global agents (`~/.config/opencode/agents/`) | 11 files, 17–139 lines each |
| Global skills (`~/.config/opencode/skill/`) | 11 files, 49–194 lines each |
| Global tools (`~/.config/opencode/tools/`) | 3 files: skill-retrieval.ts, codebase-retrieval.ts, pipeline.ts |

---

## Issues Found

---

### [WARNING] Compaction: Missing from both `opencode.json` files

Neither the project nor global config has a `compaction` key. Without `compaction.auto`,
conversations grow unbounded until they hit the context limit and fail — especially
relevant for long `build` or `spar` sessions on Claude Opus 4.6.

**Fix:** Add `"compaction": { "auto": true, "prune": true, "reserved": 10000 }` to both
`opencode.json` files.

---

### [WARNING] AGENTS.md: Project rules file is 295 lines — loads into every conversation

The project `AGENTS.md` exceeds the 200-line threshold by 95 lines. It contains three
logically distinct sections that are not universally needed:

- **Code Style** (lines 151–230, ~80 lines) — TypeScript formatting, naming tables, import
  order, error handling patterns, code examples. Only relevant when writing code, yet loads
  for every session including `explore`, `spar`, `brainstorm`, and `teach` agents.
- **Testing Conventions** (lines 234–258, ~25 lines) — Bun test structure, one-assertion-
  per-test rule, test naming. Only needed by `build`, `tester`, and `reviewer` agents.
- **Build Commands** (lines 47–98, ~52 lines) — Full bash command reference with examples.
  Reference material, not a universal rule.

**Fix:** Extract Code Style + Testing Conventions into a new project-level TypeScript skill
(`.opencode/skills/typescript/SKILL.md`), loaded on demand via `skill-retrieval`. Move Build
Commands into a separate `instructions` file referenced from `opencode.json`. This brings
`AGENTS.md` down to ~140 lines.

---

### [WARNING] `build.md` and `local.md` agents have no permission restrictions

Both agents have no `permission` block. They inherit all tools with no restrictions — every
bash command, unrestricted writes, and all 3 custom tools. If an MCP server is added to the
global config in the future, these agents will load its full tool schema without any gating.

**Fix:** Add explicit `permission` blocks to `build.md` and `local.md`. For `build.md`, a
reasonable default is `bash: { "*": allow }` with `edit: allow` — the key is making the intent
explicit so future tool additions do not silently expand scope.

---

### [INFO] `pipeline.ts` custom tool loads into all 11 agents, but only 2 need it

The `pipeline.ts` tool schema (scaffold-rust, scaffold-cpp, dev-cycle, etc.) is injected into
the context of every agent — including `explore.md`, `plan.md`, `spar.md`, `teach.md`, and
`brainstorm.md`, none of which would ever invoke a pipeline. The tool schema is not enormous,
but it is irrelevant noise for 9 of 11 agents.

**Fix:** Scope the `pipeline` tool to `build.md` and `local.md` only using `tools` frontmatter,
or move `pipeline.ts` to the project-local `.opencode/tools/` (currently empty) so it is only
active in this repo.

---

### [INFO] Global `AGENTS.md` is almost entirely redundant with the project `AGENTS.md`

The 13-line global `AGENTS.md` contains five rules that are already covered more specifically
by the project `AGENTS.md`:

- "Always run unit tests" → project AGENTS.md line 109
- "Always run coverage tools, try to achieve 90% coverage" → project AGENTS.md lines 92–98, 110
- "Always make code changes in a feature branch" → project AGENTS.md line 104
- "Commit messages to follow conventional commits" → project AGENTS.md line 265

Only the Nix dev-shell rule ("Always run build tools in their nix dev shell if there is a
flake file") adds unique value not duplicated in the project file.

**Fix:** Trim the global `AGENTS.md` to the single unique rule. Move it via Home Manager.

---

### [INFO] Internal redundancy: "no commented-out code" appears twice in project `AGENTS.md`

- Line 113: "**Never leave commented-out code** in the codebase."
- Line 230: "Do not leave commented-out code in the codebase."

**Fix:** Remove line 230; line 113 in the numbered workflow rules is the authoritative location.

---

### [INFO] `plan.md` has a duplicate step number and diverged ordering vs `planner.md`

`plan.md` lists steps 0, 1, **1**, 2, 3, 4, 5 — two items are both labelled "1." (the spar-check
step and the "Understand the goal" step). Additionally, `plan.md` and `planner.md` are near-
identical in content but have diverged in step ordering:

- `plan.md`: skill guidance first (step 0), spar check second (step 1)
- `planner.md`: spar check first (step 0), skill guidance second (step 1)

**Fix:** Fix the duplicate "1." in `plan.md` and align both files to the same step ordering
(`planner.md`'s 0–6 sequence is the correct one) so they stay in sync during future edits.

---

### [INFO] Skill directory uses singular `skill/` — may not match OpenCode native discovery

Skills live at `~/.config/opencode/skill/*/SKILL.md` (singular). The OpenCode standard path
for native skill discovery is typically `skills/` (plural). All agents explicitly load skills
via the custom `skill-retrieval` tool, so there is no functional issue today. If OpenCode's
native skill catalog feature is ever used, these skills may not appear.

**Fix:** Confirm whether this is intentional (tools-only loading) or rename `skill/` → `skills/`
in Home Manager and update `.source` entries accordingly.

---

## Rules to Cut (3 flagged)

| Rule | Location | Filter | Reason |
|------|----------|--------|--------|
| `"Prefer \`const\` over \`let\`; never use \`var\`"` | AGENTS.md line 196 | **Default** | Every modern TypeScript model applies this; Biome enforces it anyway |
| `"Use \`//\` for inline explanations of *why*, not *what*"` | AGENTS.md line 228 | **Default** | Universally known convention; adds no signal |
| `"Do not leave commented-out code in the codebase"` | AGENTS.md line 230 | **Redundancy** | Identical rule already at line 113 in the same file |

---

## No Conflicts Found

- No `CLAUDE.md` / `AGENTS.md` double-injection ✅
- No MCP servers configured (zero MCP token overhead) ✅
- All skill frontmatter `name` fields match their directory names ✅
- All skills are well under 200 lines ✅
- All agent system prompts are well under 300 lines ✅

---

## Top 3 Fixes

1. **Add compaction settings** to both `opencode.json` files — one-time, safe, immediately
   prevents context overflow in long sessions. Affects every conversation.

2. **Slim project `AGENTS.md` from 295 → ~140 lines** by extracting Code Style + Testing
   Conventions into a new project-level `typescript` skill. These ~105 lines load into every
   session including read-only ones; moving them to on-demand retrieval eliminates the waste
   with zero capability loss.

3. **Scope `pipeline.ts` to `build` and `local` agents only** — the pipeline tool schema is
   injected into 9 agents that will never invoke it.

---

## Implementation Plan

### Phase 1 — Compaction (10 min, zero risk)

**Step 1.1** — Update `/Users/Shared/PhilipsDev/ai-coding/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "github-copilot/claude-sonnet-4.6",
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 10000
  }
}
```

**Step 1.2** — Add the same `compaction` block to `~/.config/opencode/opencode.json`, then
run `home-manager switch --flake ~/Projects/home-manager#oryp6` to activate.

---

### Phase 2 — Slim AGENTS.md (30 min)

**Step 2.1** — Create `.opencode/skills/typescript/SKILL.md` in the project root. Move the
following sections from project `AGENTS.md` into it:

- "Formatting (enforced by Biome)" — lines 153–159
- "Naming Conventions" — lines 161–171
- "Imports" — lines 173–188
- "TypeScript" — lines 191–205 (drop line 196, the `const` rule — it is a Default)
- "Error Handling" — lines 208–224
- "Comments" — lines 226–230 (drop line 230 — redundant with line 113)
- "Testing Conventions" — lines 234–258

Frontmatter for the new skill:

```yaml
---
name: typescript
description: >
  TypeScript and Bun conventions for this project: formatting (Biome),
  naming, imports, type rules, error handling, and test structure.
  Triggers on: typescript, ts, bun, biome, test, interface, type, Result.
license: MIT
compatibility: opencode
---
```

**Step 2.2** — In the slimmed project `AGENTS.md`, replace the extracted sections with:

```markdown
## Code Style & Testing

Follow the TypeScript skill — loaded automatically via `skill-retrieval`
with `action: "edit"` or `action: "test"`.
```

**Step 2.3** — Remove the three flagged rules (lines 196, 228, 230).

**Step 2.4** — Trim global `AGENTS.md` to the one unique rule:

```markdown
# General rules

- Always run build tools in the Nix development shell (`nix develop . --command <cmd>`)
  when a `flake.nix` is present.
```

Update via Home Manager.

---

### Phase 3 — Fix `plan.md` + `planner.md` (15 min)

**Step 3.1** — Fix the duplicate "1." in `plan.md`: renumber to match `planner.md`'s 0–6
ordering (spar-check → skill-retrieval → understand → analyse → break down → risks → summarise).

**Step 3.2** — Align step ordering: adopt `planner.md`'s ordering as the canonical skeleton
and update `plan.md` to match. The two files should differ only in `model` and `mode`.

Update both via Home Manager.

---

### Phase 4 — Agent permissions + tool scoping (20 min)

**Step 4.1** — Add explicit `permission` blocks to `build.md` and `local.md`. Example:

```yaml
permission:
  edit: allow
  write: allow
  bash:
    "*": allow
  webfetch: allow
```

**Step 4.2** — Scope `pipeline.ts` to `build.md` and `local.md` only:
- Set `"pipeline": false` globally in `opencode.json` under a `tools` key.
- Enable it explicitly in `build.md` and `local.md` via `tools` frontmatter.
- Verify the OpenCode `tools` frontmatter syntax in the docs before applying.

---

### Phase 5 — Skill directory naming (5 min, optional)

**Step 5.1** — Decide whether `skill/` (singular) is intentional or a naming inconsistency.
If native OpenCode skill catalog discovery is desired, rename `~/.config/opencode/skill/`
to `~/.config/opencode/skills/` in the Home Manager source files, update `.source` entries
in `home.nix`, then re-activate with `home-manager switch`.

---

## Effort Summary

| Phase | Impact | Effort | Risk |
|-------|--------|--------|------|
| 1 — Compaction | HIGH — prevents context overflow | 10 min | None |
| 2 — Slim AGENTS.md | HIGH — ~105 tokens saved every conversation | 30 min | Low |
| 3 — Fix plan.md | LOW — correctness + maintenance | 15 min | None |
| 4 — Permissions + tool scoping | MEDIUM — future-proofs against MCP bloat | 20 min | Low |
| 5 — Skill dir naming | LOW — optional consistency | 5 min | Low |
