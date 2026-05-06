# Idea Brief: Dual-Profile AI OS for Coding and DevOps

## Idea

Dual-profile "AI OS" for opencode — a coding environment and a Yocto/kas devops environment, each
with isolated agents, skills, and domain-specific knowledge bases served via MCP.

## Context

An existing opencode configuration tuned for coding work (C++, Rust, ML, 3D graphics) needs a
parallel devops environment focused on Yocto embedded Linux with kas build orchestration. The two
domains require completely different mindsets, tooling, and knowledge — justifying full profile
isolation rather than a shared agent pool.

## Explored Directions

1. **Context-detection router** — Auto-detect domain from project files. Rejected: too implicit for a mindset switch.
2. **Slash command mode switch** — `/mode devops` swaps agents mid-session. Rejected: fragile runtime config mutation.
3. **Dual primary agents with task gating** — Tab-switch between coding/devops primaries, gated subagents. Rejected: agents accumulate in one config.
4. **Profile-switch via shell alias** ← Chosen direction.
5. **Router agent delegating to subagents** — Single entry point, LLM routes. Rejected: adds latency, can misclassify.

## Chosen Direction

**Explicit profile switching via shell alias/function** — two isolated config directories swapped
before launching opencode. Each profile has its own agents, skills, commands, rules, and MCP
configuration. The switch is deliberate and total, matching the "different mindset" philosophy.

## DevOps Agent Roster

### Primary Agents

| Agent   | Role                                                                    |
|---------|-------------------------------------------------------------------------|
| Build   | Default agent with full tool access. Edits recipes, kas configs, image definitions. |
| Plan    | Read-only analysis and planning. No file edits.                         |

### Subagents

| Agent      | Role                                                                                  |
|------------|---------------------------------------------------------------------------------------|
| Diagnostics | Parses build failures, queries Yocto knowledge base (MCP), suggests fixes.           |
| Recipe     | Specialist in BitBake recipe syntax (.bb, .bbappend, .inc). Writes and modifies recipes. |
| Kas-config | Specialist in kas YAML configuration — multi-config, layer includes, version pinning. |
| Image      | Image composition — IMAGE_INSTALL, DISTRO_FEATURES, packagegroups, rootfs analysis.  |
| Infra      | CI/CD pipelines, kas-container, Docker build environments, caching, build farm setup. |
| Explorer   | Read-only codebase navigation — find recipes, trace BBAPPEND chains, locate layer overrides. |
| Secrets    | Detects leaked credentials — API keys, PATs, SSH keys, tokens in repos and configs.  |
| License    | License compliance — SPDX, license manifests, recipe license auditing.               |

## Knowledge Base Architecture

**Coding profile:** Local LanceDB with CS/ML/3D graphics research papers and best practices.

**Devops profile:** LanceDB on a central server, exposed as an MCP server endpoint. Contains:
- Full Yocto Project documentation (~25K–35K chunks, ~150–200 MB)
- BitBake manual, SDK manual, kas documentation
- Known error → solution mappings
- Team runbooks and layer customizations

**Sharing model:** Teammates connect their devops profile's MCP config to the central MCP server.
No local LanceDB needed on their machines. Single writer (ingestion pipeline), multiple readers
(MCP queries).

## Key Characteristics

- **Complete isolation** between profiles: agents, skills, commands, AGENTS.md, MCP config
- **Shared base possible** for model/provider config (opencode.json)
- **MCP as the API layer** for knowledge sharing — no direct DB access needed by teammates
- **Yocto DB is feasible** at full documentation scale on a single server
- **Specialized agents over broad ones** — tight personas, each with clear domain boundaries

## Open Questions

- Switch mechanism: shell function, symlink swap, or env var manipulation?
- What's shared between profiles vs. fully isolated? (models, keybinds, themes?)
- MCP transport: SSE over internal network? Authentication needed?
- Ingestion pipeline: who curates the Yocto knowledge? Solo or team contributions?
- Query interface: single `search(query)` tool or structured tools per domain?
- Secrets agent: wrapper around gitleaks/trufflehog, or custom pattern scanning, or both?
- License agent: integrate with Yocto's own license manifest output, or independent scanning?
- Should any subagents be shared across both profiles? (e.g., Explorer pattern is similar)

## Prior Art

- **Cursor**: Per-project rules, no profile concept — [docs.cursor.com/context/rules](https://docs.cursor.com/context/rules)
- **Aider**: Chat modes (code/ask/architect), no domain switching — [aider.chat/docs/usage/modes.html](https://aider.chat/docs/usage/modes.html)
- **Continue**: Local + Hub rules, model roles, no profiles — [docs.continue.dev/customize/rules](https://docs.continue.dev/customize/rules)
- **OpenCode**: Per-project `.opencode/agents/`, global config, MCP support, permission gating — [opencode.ai/docs/agents](https://opencode.ai/docs/agents)
- **LanceDB**: Embedded vector DB, OSS is embedded-only (no self-hosted server), supports S3/NFS for shared reads — [docs.lancedb.com](https://docs.lancedb.com)
- **kas**: Build orchestration for BitBake/Yocto — [kas.readthedocs.io](https://kas.readthedocs.io/en/latest/)

## Recommended Next Steps

- **Spar** should challenge: Is 10 subagents too many? Where's the line between agent and skill?
  What about cross-domain tasks (CI for a coding project)? Is full isolation maintainable long-term?
- **Plan** should focus on: Directory structure for profiles, shell switching mechanism, MCP server
  design for Yocto knowledge, and agent prompt design for the devops roster.
