# Context Audit Skill

## Overview

The `context-audit` skill audits an OpenCode setup for token waste and context
bloat. It reads configuration files, rules, skills, agents, MCP servers, and
custom tools from disk, then returns a qualitative health rating and a
prioritised list of specific fixes.

**Trigger phrases:** "audit my context", "check my settings", "why is OpenCode
slow", "token optimization", "context audit"

**When to use it:** When sessions feel slow, when costs are unexpectedly high,
or when you've accumulated configuration over time and want to know what to cut.

**What it does NOT do:**
- It cannot read files outside the project root unless your agent has explicit
  access to `~/.config/opencode/` paths. Global config findings will be
  incomplete in that case — the skill notes which files were inaccessible
  rather than asking the user to paste them.
- It cannot inspect running process environment variables, so it cannot verify
  whether `OPENCODE_DISABLE_CLAUDE_CODE=1` is actually set.
- It does not modify any files without showing a diff and asking for
  confirmation (rules files and skills). Config-only changes (`opencode.json`)
  are offered as safe, reversible edits.

---

## Concept Mapping: Claude Code → OpenCode

This skill is adapted from a Claude Code "context audit" pattern. The table
below maps every Claude Code concept to its OpenCode equivalent. Useful for
anyone migrating.

| Claude Code | OpenCode |
|-------------|----------|
| `CLAUDE.md` (project) | `AGENTS.md` (project root) |
| `~/.claude/CLAUDE.md` | `~/.config/opencode/AGENTS.md` |
| `.claude/settings.json` | `opencode.json` (project root) |
| `~/.claude/settings.json` | `~/.config/opencode/opencode.json` |
| `.claude/skills/*/SKILL.md` | `.opencode/skills/*/SKILL.md` |
| `~/.claude/skills/*/SKILL.md` | `~/.config/opencode/skills/*/SKILL.md` |
| `/context` slash command | No equivalent — audit reads files directly |
| `autocompact_percentage_override` | `compaction.auto` + `compaction.reserved` |
| `BASH_MAX_OUTPUT_LENGTH` env var | No equivalent (handled internally) |
| `permissions.deny` (path-based) | `watcher.ignore` (glob patterns) |
| `permissions.deny` (tool-based) | `permission.<tool>: "deny"` |
| MCP servers in settings.json | `mcp` key in `opencode.json` |

**Key differences from Claude Code:**
- OpenCode has no `/context` command. The skill is fully autonomous — it reads
  everything from disk.
- OpenCode's `grep` and `glob` tools already respect `.gitignore` via ripgrep,
  so path-based deny rules are less necessary.
- MCP tools can be scoped per-agent in OpenCode, which Claude Code does not
  support — this creates an optimisation opportunity that the audit flags.
- OpenCode silently loads Claude Code compatibility files (`CLAUDE.md`,
  `.claude/skills/`) when no OpenCode-native equivalent exists. When both
  exist, both load — doubling rule injection. The audit catches this.

---

## Audit Categories

### 1. MCP Servers

**Why expensive:** Each enabled MCP server loads its full tool schema into
context on every turn — typically 15,000–20,000 tokens per server. The
OpenCode documentation explicitly warns about this overhead.

**What the audit checks:**
- Count of enabled servers (those without `"enabled": false`)
- Whether any server has a CLI alternative (GitHub CLI, Playwright CLI, etc.)
  that could replace it with zero idle token cost
- Whether servers are scoped to specific agents or load globally

**Scoping pattern (zero cost when not needed):**

```jsonc
// opencode.json
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["gh-mcp"],
      "enabled": true
    }
  },
  "tools": {
    "github_*": false   // disable globally
  },
  "agent": {
    "my-github-agent": {
      "tools": {
        "github_*": true  // enable only here
      }
    }
  }
}
```

**Severity:** CRITICAL if 3+ unscoped servers; WARNING if 1–2 unscoped;
INFO if all are scoped.

---

### 2. AGENTS.md Rules

**Why expensive:** Every rule in every loaded AGENTS.md file appears in the
system prompt on every turn. Rules that don't apply to the current task still
consume tokens.

**The five filters:**

| Filter | Description | Example |
|--------|-------------|---------|
| **Default** | The model already does this | "Write clean, readable code" |
| **Contradiction** | Conflicts with another rule | "Always use tabs" in one file, "Always use spaces" in another |
| **Redundancy** | Repeats something covered elsewhere | Same build command in both project and global AGENTS.md |
| **Bandaid** | Added to fix one bad output | "Never use `var` in JavaScript" added after one specific mistake |
| **Vague** | Changes meaning per reader | "Be natural", "Use good judgment", "Keep it clean" |

**Progressive disclosure:** Rules that only apply in specific contexts should
move out of AGENTS.md and into:
- A skill file (loaded on demand)
- A referenced instruction file via `opencode.json`'s `instructions` array
  (always loaded but separates concerns)

**Size thresholds:** WARNING at 200 lines, CRITICAL at 500 lines.

**Example AGENTS.md split using `instructions`:**

```jsonc
// opencode.json — pull task-specific rules out of AGENTS.md
{
  "instructions": [
    "docs/api-conventions.md",   // API-specific, not needed always
    "docs/release-checklist.md"  // Deployment-specific, not needed always
  ]
}
```

Then AGENTS.md keeps only universal context: repo structure, build commands,
commit conventions.

---

### 3. Instructions Array

**Why expensive:** Files referenced in the `instructions` array of
`opencode.json` are loaded into every conversation, alongside AGENTS.md.
There is no lazy loading — everything in `instructions` is always present.

**What the audit checks:**
- Line count of each referenced file (flag at 200)
- Glob patterns that could resolve to many files (`docs/**/*.md`)
- Redundancy between instruction files and AGENTS.md content

**Recommended pattern:** Use `instructions` for stable, universal reference
material (contributing guidelines, style guides). Keep task-specific material
in skills — they load on demand.

---

### 4. Skills

**Why expensive:** Unlike AGENTS.md and instructions, skills are loaded
on-demand via the `skill` tool. However, their *descriptions* always appear
in the tool description (one line each), and their *content* is injected when
loaded. Bloated skills waste tokens when they are loaded.

**What the audit checks:**
- Line count per skill (WARNING at 200, CRITICAL at 500)
- The five filters applied to skill instructions
- Synonymous instructions within a single skill
- Whether `name` in frontmatter matches the directory name

**Length context:** The existing skills in this repo average 50 lines. The
`context-audit` skill itself is ~150 lines — acceptable for an audit workflow
that is inherently more procedural than general-purpose skills.

---

### 5. Agents

**Why expensive:** Each agent's system prompt is injected at the start of
every session using that agent. Unrestricted agents also inherit all tool
schemas, including every enabled MCP server.

**What the audit checks:**
- Line count of agent system prompts (WARNING at 300, CRITICAL at 600)
- Whether agents restrict available tools via `tools` in frontmatter
- Whether agents restrict visible skills via `permission.skill` in frontmatter

**Scoping patterns in agent frontmatter:**

```markdown
---
name: my-focused-agent
description: An agent for reviewing PRs only
tools:
  write: false
  bash: false
  github_*: true
permission:
  skill:
    "reviewer": allow
    "*": deny
---
```

---

### 6. Custom Tools

**Why expensive:** Every custom tool's JSON schema is added to context for
every agent that can use it. Global tools load into every agent.

**Threshold:** INFO if ≤5 global tools; WARNING if >5.

**Recommendation:** Scope custom tools to specific agents using the same
per-agent `tools` configuration as MCP servers.

---

### 7. Compaction Settings

**Why important:** When compaction is disabled or misconfigured, sessions
overflow their context window more abruptly. OpenCode's `prune` option removes
old tool outputs to reclaim space; `reserved` prevents overflow during the
compaction process itself.

**Recommended configuration:**

```jsonc
// opencode.json
{
  "compaction": {
    "auto": true,      // compact automatically when context fills
    "prune": true,     // remove old tool outputs to reclaim tokens
    "reserved": 10000  // buffer to prevent overflow during compaction
  }
}
```

**Severity:** CRITICAL if `auto` is false or missing; WARNING if `prune` or
`reserved` is missing.

---

### 8. Claude Code Compatibility Overhead

**The problem:** OpenCode automatically loads Claude Code files as fallbacks
when no OpenCode-native equivalent exists:

- `CLAUDE.md` is used if no `AGENTS.md` exists in the same directory
- `~/.claude/CLAUDE.md` is used if no `~/.config/opencode/AGENTS.md` exists
- `.claude/skills/*/SKILL.md` is loaded alongside `.opencode/skills/*/SKILL.md`

When you have **both** files in the same location, **both are loaded**. Rules
are injected twice. Skills are registered twice (which can cause name
collisions). This is silent — there is no warning in the UI.

**Detection:** The audit flags any directory where both `AGENTS.md` and
`CLAUDE.md` coexist, and any location where both `.opencode/skills/` and
`.claude/skills/` contain files.

**Fix options:**

```bash
# Option A: remove the Claude Code files
rm CLAUDE.md
rm -rf .claude/skills/

# Option B: disable Claude Code compatibility entirely
export OPENCODE_DISABLE_CLAUDE_CODE=1

# Option C: disable selectively
export OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1  # only suppress CLAUDE.md
export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1  # only suppress .claude/skills
```

**Severity:** CRITICAL — active double-injection degrades output quality, not
just token efficiency.

---

## Rating Rubric

The audit produces one of four qualitative ratings:

| Rating | Criteria |
|--------|----------|
| **CLEAN** | ≤2 minor issues, compaction configured, no unscoped MCP bloat |
| **NEEDS WORK** | Several flagged rules, or 1–2 unscoped MCP servers, or missing compaction |
| **BLOATED** | Multiple categories with issues — large AGENTS.md, several MCP servers, large skills |
| **CRITICAL** | Contradictions between files, no compaction, heavy unscoped MCP, or Claude Code duplicates causing double injection |

Issue severity levels:

| Level | When |
|-------|------|
| CRITICAL | Actively degrades output quality or doubles injection |
| WARNING | Significant token waste with a clear fix |
| INFO | Minor improvement opportunity |

---

## Example Report

```
# Context Audit

Rating: NEEDS WORK

## Config Sources Found
- opencode.json (project root) — 42 lines
- ~/.config/opencode/opencode.json — not accessible
- AGENTS.md (project root) — 187 lines
- ~/.config/opencode/AGENTS.md — not accessible
- ~/.config/opencode/skills/programmer/SKILL.md — 49 lines
- ~/.config/opencode/skills/reviewer/SKILL.md — 50 lines
- ~/.config/opencode/skills/context-audit/SKILL.md — 152 lines
- ~/.config/opencode/agents/reviewer.md — 45 lines

## Issues Found

### [WARNING] MCP Servers: 2 unscoped servers
`github` and `sentry` are enabled globally and load into every agent
(~30,000–40,000 tokens overhead per turn).
Fix: Disable both globally with `"tools": { "github_*": false, "sentry_*": false }`
and enable per-agent where needed.

### [WARNING] AGENTS.md: 4 rules flagged

### Rules to Cut (4 flagged)
- "Write clean, readable code" — Default: the model does this without being told
- "Always handle errors explicitly" — Default: standard practice already baked in
- "Use 2-space indentation in all JS files" — Bandaid: added after one specific output
- "Be thoughtful about your responses" — Vague: no actionable meaning

### [WARNING] Compaction: prune not configured
`compaction.prune` is missing — old tool outputs accumulate instead of being pruned.
Fix: Add `"compaction": { "auto": true, "prune": true, "reserved": 10000 }` to opencode.json.

## Top 3 Fixes
1. Scope `github` and `sentry` MCP servers to specific agents — saves ~30,000–40,000
   tokens per turn for every agent that doesn't need them.
2. Enable compaction pruning — prevents tool output accumulation that inflates
   context over long sessions.
3. Remove 4 flagged AGENTS.md rules — cuts dead weight from every system prompt.
```

---

## Remediation Playbook

### Scoping MCP Servers Per Agent

The most impactful single change. Disables MCP tool schemas globally while
making them available to the one agent that needs them.

```jsonc
// opencode.json
{
  "mcp": {
    "github": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-github"],
      "enabled": true
    }
  },
  "tools": {
    "github_*": false        // 1. disable globally
  },
  "agent": {
    "gh-agent": {
      "tools": {
        "github_*": true     // 2. enable only for this agent
      }
    }
  }
}
```

### Splitting a Bloated AGENTS.md

Move task-specific rules to referenced instruction files:

```bash
# Create separate instruction files
mkdir -p docs/
# Move API conventions out of AGENTS.md
echo "# API Conventions\n..." > docs/api-conventions.md
# Move testing rules out of AGENTS.md
echo "# Testing Guidelines\n..." > docs/testing-guidelines.md
```

```jsonc
// opencode.json
{
  "instructions": [
    "docs/api-conventions.md",
    "docs/testing-guidelines.md"
  ]
}
```

Then remove those sections from AGENTS.md. Result: AGENTS.md shrinks to
universal context only. Instruction files load always but are separated.
For on-demand loading, convert them to skills instead.

### Configuring Compaction

```jsonc
// opencode.json — add or merge into existing compaction key
{
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 10000
  }
}
```

### Disabling Claude Code Compatibility

If you intentionally maintain `CLAUDE.md` for use with Claude Code directly,
but also use OpenCode, prevent double-loading with an env var:

```bash
# In your shell profile (.zshrc, .bashrc, etc.)
export OPENCODE_DISABLE_CLAUDE_CODE=1
```

Or, if you've fully migrated, delete the Claude Code files:

```bash
rm CLAUDE.md
rm ~/.claude/CLAUDE.md
rm -rf .claude/skills/
rm -rf ~/.claude/skills/
```

### Compressing an Oversized Skill

Look for these patterns to cut:

1. **Restated goals** — "This skill helps you do X" is not an instruction; cut it
2. **Hedging** — "You may want to consider..." → state it directly or remove it
3. **Synonyms** — "be concise" + "keep it short" + "don't be verbose" → pick one
4. **Obvious steps** — Remove steps the agent would take anyway without being told
5. **Examples that add no new information** — Keep examples only when they
   illustrate a non-obvious distinction

---

## Limitations

| Limitation | Impact | Workaround |
|------------|--------|------------|
| Global config (`~/.config/opencode/`) may not be readable from project scope | Audit of global rules, agents, and skills is incomplete | Run the audit from the home directory, or check global files manually |
| Cannot inspect running process environment variables | Cannot verify `OPENCODE_DISABLE_CLAUDE_CODE` is actually set | Check for duplicate files on disk — if both exist, assume both load |
| Watcher noise is unverifiable | Audit omits watcher ignore check | Note: grep/glob respect `.gitignore` via ripgrep; watcher config is rarely the bottleneck |
| MCP token counts are estimates | Actual overhead varies by server | 15,000–20,000 tokens is a conservative estimate; check actual server tool counts |

---

## Skill Location and Deployment

The `context-audit` skill lives in the `home-manager` repo:

```
home-manager/opencode/skill/context-audit/SKILL.md
```

It is auto-discovered by `modules/opencode.nix` via `builtins.readDir` and
deployed to:

```
~/.config/opencode/skills/context-audit/SKILL.md
```

No manual `home.file` entry is needed. After adding the file, run:

```bash
home-manager switch --flake .#<machine>
```

The next `bun run skill-index` run will index the new skill into LanceDB,
making it discoverable by the vector backend.

## Skill Map Integration

`context-audit` is a **utility skill** — it is not mapped to any `AIAction`
in `ACTION_SKILLS` and will not be auto-injected into `edit`, `debug`, or
other task sessions. This is intentional: auditing is a user-initiated
workflow, not a task type.

The skill is discoverable via:
1. OpenCode's native `skill` tool — agents see it in `<available_skills>`
   and load it when the user's request matches the description
2. The vector backend — semantic search will surface it for audit-related
   queries even without an explicit action mapping
