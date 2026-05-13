# Home Manager Wiring (Completed)

> **Status: Fully implemented.** All agents, skills, commands, tools, and the
> `opencode.json` config are deployed globally via `modules/opencode.nix` in
> the home-manager repo. The ai-coding repo is consumed as a **Nix flake
> input** — no local clone is required on disk.

## Current Deployment

Everything under `~/.config/opencode/` is managed by `modules/opencode.nix`
in the home-manager repo. The table below shows how each item is deployed.

| Path | Source | Mechanism |
|------|--------|-----------|
| `opencode.json` | `${aiCodingPkg}/opencode.json` | Nix store copy — pinned to the flake input |
| `AGENTS.md` | `opencode/AGENTS.md` in home-manager repo | Nix store copy |
| `agents/<name>.md` | `opencode/agents/` in home-manager repo | Nix store copies — auto-discovered |
| `skills/<name>/SKILL.md` | `opencode/skills/` in home-manager repo | Nix store copies — auto-discovered |
| `commands/<name>.md` | `opencode/commands/` in home-manager repo | Nix store copies — auto-discovered |
| `tools/<name>.ts` | `opencode/tools/` in home-manager repo | `mkOutOfStoreSymlink` — live, edits are immediate |
| `package.json` | `opencode/package.json` in home-manager repo | Nix store copy |

`AI_CODING_MONOREPO` is set automatically in `home.sessionVariables` to the
Nix store path of the built ai-coding package (`${aiCodingPkg}`). No manual
export or local clone is needed.

### Updating opencode.json

`opencode.json` is pinned to the `ai-coding` flake input. To pick up a new
version after pushing changes to the `ai-coding` repo:

```bash
cd ~/Projects/home-manager
nix flake update ai-coding
home-manager switch --flake .#<machine>
```

### Adding agents, skills, commands, or tools

Drop the file in the appropriate directory in the home-manager repo, `git add`
it, and run `home-manager switch`. Auto-discovery picks it up automatically —
no changes to `home.nix` needed.

For tools specifically: because they use `mkOutOfStoreSymlink`, edits to
`opencode/tools/*.ts` are reflected immediately without a `home-manager switch`.
Run `bun install --cwd ~/.config/opencode` if a new tool adds a dependency.

## Tools

Custom OpenCode tools (`pipeline.ts`, `codebase-retrieval.ts`,
`skill-retrieval.ts`) live in `opencode/tools/` in the home-manager repo.
They are deployed as live symlinks into `~/.config/opencode/tools/` via
`mkOutOfStoreSymlink`, pointing back to `~/Projects/home-manager/opencode/tools/`.

`bun install` runs in `~/.config/opencode/` and `~/Projects/home-manager/opencode/`
during Home Manager activation (the `installAiCodingDeps` activation step) to
provide the `@opencode-ai/plugin` dependency. The `package.json` is deployed
as a Nix store copy from `opencode/package.json` in the home-manager repo.
