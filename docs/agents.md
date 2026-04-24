# Agents

## Overview

The AI Coding OS deploys a set of OpenCode agents globally via Home Manager.
They are available in every project without any per-project configuration.

There are two types:

- **Primary agents** — Tab-switchable in the OpenCode TUI. Each has its own
  persistent conversation context within a session. Use these for sustained,
  multi-turn work.
- **Subagents** — Invoked with `@name` from within any primary agent session.
  Short-lived delegation targets for focused tasks. The primary agent resumes
  after the subagent responds.

All agents use GitHub Copilot (`github-copilot/claude-opus-4.6` or
`github-copilot/claude-sonnet-4.6`) and are deployed as Nix store symlinks
under `~/.config/opencode/agents/`.

---

## Primary Agents

| Name | Model | Temp | Write | Web | Purpose |
|------|-------|------|-------|-----|---------|
| `plan` | Opus 4.6 | 0.3 | deny | ask | Architecture decisions and deep analysis |
| `build` | Sonnet 4.6 | 0.5 | allow | — | Full development — implement, refactor, test, ship |
| `local` | Sonnet 4.6 | 0.3 | allow | — | General-purpose experimentation |
| `explore` | Sonnet 4.6 | 0.3 | deny | allow | Read-only codebase exploration and Q&A |
| `spar` | Opus 4.6 | 0.5 | ask | allow | Socratic sparring partner for feature discussions |
| `teach` | Opus 4.6 | 0.5 | deny | allow | Adaptive tutor — teaches from project context and broad knowledge |

### plan

Powered by Claude Opus 4.6. Use when you need deep architectural analysis,
tradeoff evaluation, or a structured implementation plan.

- Reads `.spar/brief.md` if present in the project root and incorporates
  relevant context -- but does not require it. Most planning sessions start
  without a prior sparring session.
- Produces numbered, ordered plans with risks and open decisions called out.
- Never writes or edits files.

### build

The default development agent. Full access -- reads, writes, edits files, runs
shell commands, commits. Use for implementing features, fixing bugs, refactoring,
and shipping.

### local

General-purpose slot. Same model and access as `build` but with fewer steps
configured, making it lighter for experimentation, quick questions, or tasks
that don't fit the other agents.

### explore

Read-only. Use when you want to understand an unfamiliar codebase, trace a call
chain, or answer "how does X work?" questions. Never writes or edits files.

Can fetch external URLs freely -- useful for cross-referencing documentation or
RFCs while exploring.

### spar

Powered by Claude Opus 4.6. A Socratic sparring partner for discussing new
features **before** you invest in planning or implementation.

**What it does:**
- Challenges your assumptions about whether the feature is needed and whether
  the problem statement is correct
- Asks probing questions one or two at a time -- never a barrage
- Surfaces non-obvious concerns: maintenance burden, security surface,
  backwards compatibility, performance implications, migration cost
- Proposes alternatives grounded in what the codebase already supports
- Reads the codebase to anchor the discussion in reality -- not abstractions

**What it does not do:**
- Does not produce implementation plans (that is `plan`)
- Does not explain existing code (that is `explore`)
- Does not write or edit production files

**Decision Brief handoff:**
When you signal you are ready to move to planning, `spar` produces a structured
Decision Brief (see [The Spar → Plan Handoff](#the-spar--plan-handoff-optional)
below) and offers to write it to `.spar/brief.md`. You confirm the write. The
`plan` agent reads this file automatically on its next session start.

**When to use `spar`:**
- The feature touches multiple modules or has unclear scope
- You are unsure whether the feature is worth building at all
- You want your assumptions stress-tested before investing in a plan
- You have a strong opinion and want it challenged

**Example exchange:**

```
You:  I want to add retry logic to the HTTP client with exponential backoff.

spar: Before we get into the mechanism -- what's the failure mode you're
      actually seeing? Is this about transient network errors, rate limiting,
      or something else? The right retry strategy differs significantly.

You:  Mostly transient network errors from the Copilot API.

spar: Got it. Looking at copilot-dispatcher.ts line 34 -- the dispatcher
      currently throws on any non-2xx. Do you want retries at the dispatcher
      level, or higher up in orchestrate()? Retrying at the dispatcher keeps
      it transparent to callers, but means you can't distinguish "retried and
      succeeded" from "succeeded first try" in your pipeline metrics. Does
      that distinction matter to you?
```

### teach

Powered by Claude Opus 4.6. An adaptive tutor that helps you deeply understand
concepts -- not just get answers. It reads the current project for concrete
teaching material and can fetch external documentation, specs, and tutorials.

**What it does:**
- Assesses your knowledge level from your questions and adapts its depth
  continuously -- starts explanatory, shifts to Socratic as you demonstrate
  understanding
- Reads the codebase to ground explanations in real code you are working with;
  cites exact file paths and line numbers
- Fetches external documentation, language specs, RFCs, and tutorials via web;
  always cites the source URL
- Checks your understanding by asking you to explain back, predict behavior,
  or spot errors in a snippet
- Bridges project-specific patterns to general CS, programming, and math
  concepts -- building transferable knowledge, not just project muscle memory
- Teaches any topic: project patterns, TypeScript, Rust, Nix, data structures,
  type theory, networking, systems design, math -- anything you want to learn

**What it does not do:**
- Does not write, edit, or create files
- Does not solve your problem directly -- guides you to the answer through
  questions and scaffolded explanations
- Does not produce session notes or quiz files (conversation is the lesson)

**When to use `teach`:**
- You want to understand *why* something works, not just *how* to use it
- You are working with an unfamiliar pattern and want to learn the underlying
  concept before implementing
- You want to learn a broader topic (type theory, monads, async runtimes) with
  your project as a concrete anchor
- You want to be challenged and quizzed, not just given answers
- You are onboarding to an unfamiliar codebase and want to build real
  understanding, not just copy patterns

**Distinction from `explore`:**
`explore` answers "how does this code work?" by showing you the code.
`teach` answers "why does this work?" by building your understanding.
`explore` is a reference tool; `teach` is a classroom.

**Example exchange:**

```
You:   Why does the model router use a profile instead of just hardcoding
       the model name?

teach: Good question -- let me show you the relevant code first.
       [reads model-profiles.ts and select-model.ts]

       The profile system is an instance of a classic design pattern called
       the Strategy pattern. The router doesn't know *which* model to use --
       it only knows *how* to ask for one given a role. The profile supplies
       the actual answer.

       Before I explain further: what do you think would break if you
       hardcoded "claude-sonnet-4.6" directly in selectModel()?

You:   You couldn't switch models without changing the code?

teach: Exactly. And what else? Think about the test suite -- how would you
       test selectModel() if the model name is hardcoded?
```

---

## Subagents

Invoke with `@name` from within any primary agent session.

| Name | Model | Permissions | Purpose |
|------|-------|-------------|---------|
| `@planner` | Sonnet 4.6 | read + git | Planning within a session |
| `@debugger` | Sonnet 4.6 | read + git + bun test | Root-cause diagnosis |
| `@reviewer` | Sonnet 4.6 | read + git + bun test | Code review (quality, correctness, security) |
| `@tester` | Sonnet 4.6 | read + git + bun test | Test writing and coverage improvement |

### @planner

Produces a numbered, ordered plan for a given task. Read-only -- does not write
or edit files. Also reads `.spar/brief.md` if present.

### @debugger

Diagnoses bugs and failing tests. Traces execution paths, identifies root
causes, and proposes a fix in plain terms -- but does not apply it. Can run
`bun test` and `bunx tsc --noEmit` to gather diagnostic output.

### @reviewer

Reviews code or a diff for quality, correctness, security, and adherence to
project conventions. Produces findings grouped by severity: blocking / warning /
suggestion. Can run `bun test` and `bunx tsc --noEmit` to validate changes.

### @tester

Writes tests and improves coverage. Co-locates test files next to source,
targets ≥ 90% coverage, and marks genuinely untestable code with
`/* v8 ignore start */` / `/* v8 ignore stop */`. Does not edit production
source files.

---

## The Spar → Plan Handoff (Optional)

`spar` is **not** a prerequisite for `plan`. Most planning sessions start
directly. Use the handoff when you want the insights from a sparring session
to carry forward automatically.

### How it works

```
spar session
    │
    ▼
Decision Brief (displayed in chat)
    │
    ├─── written to .spar/brief.md  ◄── you confirm the write
    │
    ▼
plan session start
    │
    ├─── .spar/brief.md present? ──yes──► read and incorporate relevant context
    │
    └─── .spar/brief.md absent? ──────► proceed normally, no change in behaviour
```

### Decision Brief format

```markdown
## Feature
One-line description of what is being built.

## Key decisions made
Bullet list of what was resolved during the discussion.

## Open questions
What still needs answering before or during planning.

## Rejected alternatives
What was considered and why it was dropped.

## Risks identified
Concerns surfaced during the discussion, ordered by severity.

## Recommended next steps
What the plan agent should focus on first.
```

### Notes

- `.spar/brief.md` is **overwritten** on each new brief -- it reflects the
  most recent sparring session only.
- `.spar/` is gitignored -- briefs are ephemeral working artifacts, not
  project history.
- `spar` uses `write: ask` permission -- you are always prompted before the
  file is written.

---

## Recommended Workflows

### Quick path (most common)

For well-understood features or straightforward changes:

```
explore → plan → build → @reviewer → commit
```

### Deep-dive path (complex or risky features)

For features with unclear scope, multiple affected modules, or strong
assumptions that need testing:

```
explore → spar → plan → build → @reviewer → commit
```

**Use the deep-dive path when:**
- You are unsure whether the feature is worth building
- The feature touches multiple modules or crosses architectural boundaries
- You have a strong opinion and want it challenged before investing in a plan
- The feature has significant backwards-compatibility or security implications

### Learning path (understanding before doing)

For situations where you need to understand a concept or pattern before
implementing:

```
teach → explore → plan → build → @reviewer → commit
```

**Use the learning path when:**
- You are working with a pattern or technology you do not fully understand
- You want to learn the theory behind what the code is doing before touching it
- You are onboarding to an unfamiliar codebase and want real understanding, not
  just pattern-matching
- You want your understanding tested before you start writing code

---

## Agent Design Principles

- **Clear, non-overlapping purpose** -- each agent does one thing well; if two
  agents feel interchangeable, one of them needs a sharper definition
- **Minimal permissions** -- agents get only the access they need; read-only
  agents never have write/edit permissions (spar is the sole exception, with
  `write: ask` for the single handoff file)
- **Temperature guidelines:**
  - 0.1–0.2: diagnostic (debugger) -- deterministic, precise
  - 0.2–0.3: analytical (planner, reviewer, tester, plan, explore) -- structured
  - 0.5: generative (build, spar, teach) -- creative thinking, implementation, and teaching
- **Subagents mirror primary agents** -- `@planner` is the delegation-target
  version of `plan`; same capability, short-lived context

---

## How to Add a New Agent

1. **Create the agent file** in `~/Projects/home-manager/opencode/agents/<name>.md`
   with the standard frontmatter (description, mode, model, temperature,
   permission block).

2. **Add a `.source` entry** in `~/Projects/home-manager/home.nix` under the
   appropriate comment block (primary agents or subagents).

3. **Update this document** -- add the agent to the relevant table and write a
   description section.

4. **Update `docs/ai-coding-os-setup.md`** -- add the agent to the Primary
   Agents or Subagents table and update the Daily Workflow if the agent changes
   the recommended flow.

5. **Deploy:**
   ```bash
   rm -f ~/.config/opencode/agents/<name>.md
   home-manager switch --flake ~/Projects/home-manager#oryp6
   ls -la ~/.config/opencode/agents/<name>.md   # verify Nix store symlink
   ```

6. **If the agent is project-local** (scoped to `ai-coding/` only), also add
   it to `.opencode/agents/` in this repo. Keep the two copies in sync.

---

## Where Agent Files Live

```
~/Projects/home-manager/
  opencode/agents/
    plan.md          ← source of truth for global primary agents
    build.md
    local.md
    explore.md
    spar.md
    teach.md
    planner.md       ← source of truth for global subagents
    debugger.md
    reviewer.md
    tester.md
  home.nix           ← registers each agent as a Nix store symlink

~/.config/opencode/agents/
    plan.md          → /nix/store/.../plan.md      (symlink)
    build.md         → /nix/store/.../build.md     (symlink)
    local.md         → /nix/store/.../local.md     (symlink)
    explore.md       → /nix/store/.../explore.md   (symlink)
    spar.md          → /nix/store/.../spar.md      (symlink)
    teach.md         → /nix/store/.../teach.md     (symlink)
    planner.md       → /nix/store/.../planner.md   (symlink)
    debugger.md      → /nix/store/.../debugger.md  (symlink)
    reviewer.md      → /nix/store/.../reviewer.md  (symlink)
    tester.md        → /nix/store/.../tester.md    (symlink)

~/Projects/ai-coding/.opencode/agents/
    planner.md       ← project-local copy (kept in sync with home-manager)
    debugger.md
    reviewer.md
    tester.md
```

OpenCode reads `~/.config/opencode/agents/` for global agents and
`.opencode/agents/` in the current project for project-local overrides.
