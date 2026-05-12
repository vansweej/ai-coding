# Home Manager Wiring Plan (Completed)

> **Status: Fully implemented.** This document describes the original wiring
> plan. The home-manager repo now deploys all agents, skills, commands, tools,
> and the opencode.json config globally via `home.nix`. The ai-coding repo no
> longer contains a `.opencode/` directory — all OpenCode configuration is
> self-contained in `~/Projects/home-manager/opencode/`.

## Goal

Make the subagents and OpenCode config available globally in every project --
not just when OpenCode is launched from inside `~/Projects/ai-coding/`.

---

## State at Time of Writing (Now Completed)

| What | Where | Status |
|------|-------|--------|
| Agent profiles | `.opencode/agents/planner.md` | Worked only in `ai-coding/` project |
| Agent profiles | `.opencode/agents/debugger.md` | Worked only in `ai-coding/` project |
| OpenCode config | `opencode.json` | Source for Home Manager symlink |
| Home Manager config | `~/Projects/home-manager/home.nix` | No OpenCode entries yet |

The `opencode/` directory was explicitly designed as a Home Manager symlink
source. The wiring has since been added to `home.nix`.

---

## Target State

After `home-manager switch`:

```
~/.config/opencode/
├── AGENTS.md         → ~/Projects/home-manager/opencode/AGENTS.md (language-agnostic rules)
├── skills/
│   ├── analyst/SKILL.md    → .../opencode/skills/analyst/SKILL.md
│   ├── architect/SKILL.md  → .../opencode/skills/architect/SKILL.md
│   ├── documenter/SKILL.md → .../opencode/skills/documenter/SKILL.md
│   ├── explorer/SKILL.md   → .../opencode/skills/explorer/SKILL.md
│   ├── programmer/SKILL.md → .../opencode/skills/programmer/SKILL.md
│   ├── reviewer/SKILL.md   → .../opencode/skills/reviewer/SKILL.md
│   ├── tester/SKILL.md     → .../opencode/skills/tester/SKILL.md
│   ├── rust/SKILL.md       → .../opencode/skills/rust/SKILL.md   ← language skill
│   └── cpp/SKILL.md        → .../opencode/skills/cpp/SKILL.md    ← language skill
├── agents/
│   ├── plan.md       → ~/Projects/home-manager/opencode/agents/plan.md
│   ├── build.md      → ~/Projects/home-manager/opencode/agents/build.md
│   ├── local.md      → ~/Projects/home-manager/opencode/agents/local.md
│   ├── explore.md    → ~/Projects/home-manager/opencode/agents/explore.md
│   ├── spar.md       → ~/Projects/home-manager/opencode/agents/spar.md
│   ├── planner.md    → ~/Projects/home-manager/opencode/agents/planner.md
│   ├── debugger.md   → ~/Projects/home-manager/opencode/agents/debugger.md
│   ├── reviewer.md   → ~/Projects/home-manager/opencode/agents/reviewer.md
│   └── tester.md     → ~/Projects/home-manager/opencode/agents/tester.md
└── opencode.json     ⇝ ~/Projects/ai-coding/opencode.json (live symlink)
```

All subagents work in any project. `claude-sonnet-4.6` via GitHub Copilot is
the default model for all sessions.

---

## Steps

### Step 1 — Read home.nix

Read `~/Projects/home-manager/home.nix` to understand its current structure
(imports, module layout, existing `home.file` entries if any) before making
any changes.

### Step 2 — Add OpenCode entries to home.nix

Add a `home.file` block (or extend an existing one) with three entries:

```nix
home.file = {
  ".config/opencode/agents/planner.md".source =
    config.lib.file.mkOutOfStoreSymlink
      "${config.home.homeDirectory}/Projects/ai-coding/opencode/profiles/planner.md";

  ".config/opencode/agents/debugger.md".source =
    config.lib.file.mkOutOfStoreSymlink
      "${config.home.homeDirectory}/Projects/ai-coding/opencode/profiles/debugger.md";

  ".config/opencode/opencode.json".source =
    config.lib.file.mkOutOfStoreSymlink
      "${config.home.homeDirectory}/Projects/ai-coding/opencode.json";
};
```

`mkOutOfStoreSymlink` is used instead of a plain `.source` because the source
files are mutable (tracked in a git repo, not the Nix store). This creates
real symlinks that follow edits to the source files without requiring
`home-manager switch` on every change.

Note: if `home.nix` already has a `home.file` block, merge these entries into
it rather than adding a duplicate attribute.

### Step 3 — Verify symlink targets exist

Before running `home-manager switch`, confirm all three source files are
present:

```bash
ls ~/Projects/ai-coding/opencode/profiles/planner.md
ls ~/Projects/ai-coding/opencode/profiles/debugger.md
ls ~/Projects/ai-coding/opencode.json
```

### Step 4 — Apply with home-manager switch

```bash
cd ~/Projects/home-manager
home-manager switch --flake .
```

### Step 5 — Verify symlinks were created

```bash
ls -la ~/.config/opencode/
ls -la ~/.config/opencode/agents/
```

Expected output:

```
~/.config/opencode/opencode.json  ->  ~/Projects/ai-coding/opencode.json
~/.config/opencode/agents/planner.md   ->  ~/Projects/ai-coding/opencode/profiles/planner.md
~/.config/opencode/agents/debugger.md  ->  ~/Projects/ai-coding/opencode/profiles/debugger.md
```

### Step 6 — Smoke test

```bash
# From a different project, not ai-coding/
cd ~/Projects/home-manager
opencode
# Type: @planner what does this repo do?
# Expected: Claude Sonnet responds via GitHub Copilot
```

---

## Risk Notes

- If `~/.config/opencode/opencode.json` already exists as a regular file
  (written by OpenCode itself), Home Manager will refuse to overwrite it.
  Solution: delete or move the existing file first, then run `home-manager switch`.

- If `~/.config/opencode/agents/` does not exist, Home Manager will create it.
  No manual `mkdir` needed.

- The `opencode.json` at the repo root (`~/Projects/ai-coding/opencode.json`)
  is the single source of truth for the global OpenCode config. The symlink in
  `~/.config/opencode/opencode.json` points directly to this file.

---

## Tools

Custom OpenCode tools (`pipeline.ts`, `codebase-retrieval.ts`,
`skill-retrieval.ts`) live in `opencode/tools/` in the home-manager repo.
They are deployed as live symlinks into `~/.config/opencode/tools/` via
`mkOutOfStoreSymlink`, pointing back to `~/Projects/home-manager/opencode/tools/`.

`bun install` runs in `~/.config/opencode/` during Home Manager activation to
provide the `@opencode-ai/plugin` dependency. The `package.json` is deployed
as a Nix store copy from `opencode/package.json` in the home-manager repo.
