# Home Manager Wiring Plan

## Goal

Make the `@planner` (Claude Sonnet) and `@debugger` (DeepSeek) agents, and the
Ollama provider config, available globally in every project -- not just when
OpenCode is launched from inside `~/Projects/ai-coding/`.

---

## Current State

| What | Where | Status |
|------|-------|--------|
| Agent profiles | `.opencode/agents/planner.md` | Works only in `ai-coding/` project |
| Agent profiles | `.opencode/agents/debugger.md` | Works only in `ai-coding/` project |
| Profile copies | `opencode/profiles/planner.md` | Source for Home Manager symlink |
| Profile copies | `opencode/profiles/debugger.md` | Source for Home Manager symlink |
| Ollama provider config | `opencode/mappings/opencode.json` | Source for Home Manager symlink |
| Home Manager config | `~/Projects/home-manager/home.nix` | No OpenCode entries yet |

The `opencode/` directory was explicitly designed as a Home Manager symlink
source. The wiring just hasn't been added to `home.nix` yet.

---

## Target State

After `home-manager switch`:

```
~/.config/opencode/
├── agents/
│   ├── planner.md    → ~/Projects/ai-coding/opencode/profiles/planner.md
│   └── debugger.md   → ~/Projects/ai-coding/opencode/profiles/debugger.md
└── opencode.json     → ~/Projects/ai-coding/opencode/mappings/opencode.json
```

`@planner` and `@debugger` work in any project, Ollama models are always
registered, `qwen3:8b` is always the default model.

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
      "${config.home.homeDirectory}/Projects/ai-coding/opencode/mappings/opencode.json";
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
ls ~/Projects/ai-coding/opencode/mappings/opencode.json
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
~/.config/opencode/opencode.json  ->  ~/Projects/ai-coding/opencode/mappings/opencode.json
~/.config/opencode/agents/planner.md   ->  ~/Projects/ai-coding/opencode/profiles/planner.md
~/.config/opencode/agents/debugger.md  ->  ~/Projects/ai-coding/opencode/profiles/debugger.md
```

### Step 6 — Smoke test

```bash
# From a different project, not ai-coding/
cd ~/Projects/home-manager
opencode
# Type: @planner what does this repo do?
# Expected: Claude Sonnet responds (not qwen)
```

---

## Risk Notes

- If `~/.config/opencode/opencode.json` already exists as a regular file
  (written by OpenCode itself), Home Manager will refuse to overwrite it.
  Solution: delete or move the existing file first, then run `home-manager switch`.

- If `~/.config/opencode/agents/` does not exist, Home Manager will create it.
  No manual `mkdir` needed.

- The `opencode.json` at the repo root (`~/Projects/ai-coding/opencode.json`)
  is a separate file used when running OpenCode from inside the `ai-coding`
  project. The symlink targets `opencode/mappings/opencode.json` for the global
  config. Both files have identical contents -- they can be kept in sync or
  merged into one source of truth later.

---

## Future: Keeping Profiles in Sync

The agent profiles exist in two places within the repo:

| Path | Purpose |
|------|---------|
| `.opencode/agents/` | Per-project, picked up automatically by OpenCode |
| `opencode/profiles/` | Home Manager symlink source (global) |

They are currently manually kept identical. A future improvement would be to
have `.opencode/agents/` contain symlinks pointing to `opencode/profiles/`,
eliminating the duplication. This is tracked as a known improvement.
