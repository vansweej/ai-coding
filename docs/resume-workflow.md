# Resume Workflow — Deep Dive

The `rust-plan-cycle` pipeline supports automatic resumption from the last completed phase
using git commit trailers and optional memory tracking. This document explains the resume
mechanism in detail.

## Table of Contents

1. [Overview](#overview)
2. [Resume Detection](#resume-detection)
3. [Phase Trailers](#phase-trailers)
4. [Resume Algorithm](#resume-algorithm)
5. [Dirty State Handling](#dirty-state-handling)
6. [Memory-Based Resume](#memory-based-resume)
7. [Manual Resume Control](#manual-resume-control)
8. [Examples](#examples)
9. [Troubleshooting](#troubleshooting)

---

## Overview

### What is Resume?

Resume is the ability to continue a multi-phase pipeline from where it left off after
a failure or interruption. Instead of restarting from Phase 1, the pipeline:

1. Detects the last completed phase
2. Resets the working directory to that phase's commit
3. Skips all completed phases
4. Continues with the next phase

### Why Resume?

Resume enables:

- **Fault tolerance**: Recover from transient failures without losing progress
- **Iterative development**: Fix issues and continue without restarting
- **Cost efficiency**: Avoid re-running expensive phases
- **Better UX**: Users don't need to manually track progress

---

## Resume Detection

### Git-Based Detection

The pipeline scans git commit messages for `Phase: N` trailers:

```bash
$ git log --oneline --format=%B
feat: add auth tests
Phase: 2

feat: add auth module
Phase: 1

initial commit
```

The resume detector:

1. Scans git log from HEAD backwards
2. Finds the first commit with a `Phase: N` trailer
3. Extracts the phase number
4. Returns `{ needsResume: true, lastPhaseNumber: 2 }`

### Resume State Detection

```typescript
interface ResumeState {
  needsResume: boolean;
  lastPhaseNumber?: number;
}

async function detectResumeState(workspace: string): Promise<ResumeState> {
  // Scan git log for Phase: N trailers
  // Return the last completed phase number
}
```

### When Resume is Triggered

Resume is triggered whenever a `Phase: N` trailer is found in recent git history —
**regardless of whether the working directory is currently dirty or clean.**

Resume is **not** triggered only when:

1. **First run**: No Phase trailers exist anywhere in the scanned git log window

A clean working directory does **not** mean "nothing to resume." A phase can fail during
patch application and roll back to a fully clean tree (patch application never partially
writes files), which is indistinguishable from "no run has started yet" if resume only
looked at dirtiness. Gating resume on dirty state caused exactly this bug: a feature with
phases 1–6 committed and phase 7 failing cleanly would, on the next run, be silently
restarted from phase 1 instead of continuing at phase 7 — re-applying already-committed
phases and colliding with their now-stale SEARCH anchors. `resetToPhaseCommit` is always
called before phases resume, and is a safe no-op when the tree already matches the target
commit, so there is no cost to always resetting.

---

## Phase Trailers

### Trailer Format

Each phase commit includes a `Phase: N` trailer:

```
feat: add auth module

Phase: 1
```

### Trailer Parsing

The trailer is extracted from the commit message:

```typescript
const trailerRegex = /^Phase:\s*(\d+)$/m;
const match = commitMessage.match(trailerRegex);
const phaseNumber = parseInt(match[1], 10);
```

### Trailer Generation

When committing a phase, the trailer is automatically added:

```typescript
const messageWithTrailer = `${commitMessage}\n\nPhase: ${phaseNumber}`;
await $`git commit -m ${messageWithTrailer}`.cwd(workspace);
```

---

## Resume Algorithm

### Step-by-Step

1. **Parse plan file**
   - Extract all phases and steps
   - Validate plan structure

2. **Detect resume state**
   - Scan git log for Phase trailers
   - Find last completed phase number (dirty vs. clean tree does not matter)

3. **If resume needed**
   - Get the commit hash of the last phase
   - Reset working directory to that commit
   - Calculate start phase index (lastPhaseNumber)

4. **Execute phases**
   - Skip phases 0 to lastPhaseNumber-1
   - Execute phases from lastPhaseNumber onwards
   - Commit each phase with Phase trailer

5. **Exit with status**
   - 0: all phases passed
   - 2: phase exhausted repair budget
   - 3: input/environment error

### Pseudocode

```typescript
async function runFeature(planContent: string, options: RunPhaseOptions) {
  // 1. Parse plan
  const parsed = parsePlanFile(planContent);
  if (!parsed.ok) return parsed;

  // 2. Detect resume state
  const resumeState = await detectResumeState(options.workspace);
  let startPhaseIndex = 0;

  // 3. If resume needed, reset and skip completed phases
  if (resumeState.needsResume && resumeState.lastPhaseNumber !== undefined) {
    const resetResult = await resetToPhaseCommit(
      options.workspace,
      resumeState.lastPhaseNumber
    );
    if (!resetResult.ok) return resetResult;
    startPhaseIndex = resumeState.lastPhaseNumber;
  }

  // 4. Execute phases
  const phaseResults: PhaseRunResult[] = [];
  for (let i = startPhaseIndex; i < parsed.value.phases.length; i++) {
    const phase = parsed.value.phases[i];
    const result = await runPhase(phase, options);
    if (!result.ok) return result;
    phaseResults.push(result.value);
  }

  // 5. Return success
  return { ok: true, value: { feature: parsed.value.feature, phases: phaseResults } };
}
```

---

## Dirty State Handling

### What is Dirty State?

A dirty working directory has uncommitted changes:

```bash
$ git status
On branch feat/my-feature
Changes not staged for commit:
  modified:   src/auth/mod.rs
  modified:   src/lib.rs
```

### Reset Always Runs on Resume

Whenever a `Phase: N` trailer is found, the pipeline always resets to that phase's commit
before continuing — whether the tree is currently dirty or already clean:

```typescript
// 1. Find the last completed phase commit
const lastPhaseCommit = await findPhaseCommit(workspace, lastPhaseNumber);

// 2. Reset to that commit (discards any uncommitted changes; a no-op if the
//    tree already matches the target commit)
await $`git reset --hard ${lastPhaseCommit}`.cwd(workspace);
await $`git clean -fd`.cwd(workspace);

// 3. Continue with the next phase
```

This is deliberately unconditional. Earlier versions of the resume detector only reset when
the tree was dirty, which meant a phase that failed and rolled back to a *clean* tree (patch
application never partially writes) was treated as "no resume needed" and silently restarted
the whole feature from phase 1. Since the reset is a safe no-op on an already-clean,
already-matching tree, there's no downside to always performing it.

### Preserving Changes

If you want to preserve uncommitted changes:

```bash
# 1. Stash changes
git stash

# 2. Run the pipeline (will reset to last phase)
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md

# 3. If needed, restore changes
git stash pop
```

---

## Memory-Based Resume

### Memory Consultation

During resume, the pipeline can consult memory for additional context:

```typescript
// Query memory for phase completion status
const completedPhases = await memory.recall(
  "phase completion status",
  100
);

// Parse responses to understand prior progress
// Use this to inform the next phase's context
```

### Memory Advantages

Memory provides:

1. **Richer context**: Not just phase number, but full phase details
2. **Diagnostic info**: Error messages, retry counts, escalation history
3. **Learning**: Patterns from previous attempts
4. **Cross-session**: Information persists across pipeline runs

### Memory Limitations

Memory has limitations:

1. **Optional**: Not required for resume to work
2. **Eventual consistency**: Cortex (long-term) is eventually consistent
3. **Scope isolation**: Memories are scoped (global, user, agent, session)

---

## Manual Resume Control

### Finding Phase Commits

List all phase commits:

```bash
git log --oneline --grep="Phase:"
# Output:
# abc1234 feat: add auth tests
# def5678 feat: add auth module
# ghi9012 initial commit
```

### Resetting to a Specific Phase

Reset to a specific phase commit:

```bash
# Reset to Phase 1
git reset --hard def5678

# Or use git log to find it
git reset --hard $(git log --oneline --grep="Phase: 1" | head -1 | cut -d' ' -f1)
```

### Continuing from a Specific Phase

After resetting, run the pipeline again:

```bash
# Reset to Phase 1
git reset --hard <phase-1-commit>

# Run the pipeline (will detect Phase 1 and continue with Phase 2)
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
```

### Skipping Phases

To skip a phase and continue with the next:

```bash
# Reset to the phase you want to skip
git reset --hard <phase-n-commit>

# Run the pipeline (will skip to phase n+1)
bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
```

---

## Examples

### Example 1: Simple Resume

**Scenario**: Phase 1 passes, Phase 2 fails.

```bash
# Initial run
$ bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
# ... Phase 1 passes ...
# ... Phase 2 fails ...
# Exit code: 2

# Check git log
$ git log --oneline --grep="Phase:"
abc1234 feat: add auth module
Phase: 1

# Fix the issue
$ vim src/auth/mod.rs

# Resume (pipeline detects Phase 1 and continues with Phase 2)
$ bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
# ... Phase 2 passes ...
# Exit code: 0
```

### Example 2: Resume After a Clean Rollback

**Scenario**: Phase 1 passes, Phase 2 fails during patch application and rolls back to a
clean tree (no uncommitted changes left behind).

```bash
# Initial run
$ bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
# ... Phase 1 passes and commits with a Phase: 1 trailer ...
# ... Phase 2's patch fails to apply and rolls back cleanly ...
# Exit code: 2

# Working directory is clean -- this does NOT mean "nothing to resume"
$ git status
On branch feat/my-feature
nothing to commit, working tree clean

# Resume (pipeline finds the Phase: 1 trailer regardless of clean tree,
# resets to it as a no-op, and continues with Phase 2)
$ bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
# ... Phase 2 passes ...
# Exit code: 0
```

### Example 3: Manual Resume Control

**Scenario**: Need to skip Phase 2 and continue with Phase 3.

```bash
# Find Phase 1 commit
$ git log --oneline --grep="Phase: 1"
abc1234 feat: add auth module

# Reset to Phase 1
$ git reset --hard abc1234

# Run the pipeline (will skip Phase 1 and Phase 2, continue with Phase 3)
$ bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
# ... Phase 3 passes ...
# Exit code: 0
```

### Example 4: Resume with Memory

**Scenario**: Phase 1 passes, Phase 2 fails, memory is available.

```bash
# Initial run
$ bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
# ... Phase 1 passes (stored in memory) ...
# ... Phase 2 fails ...
# Exit code: 2

# Resume (pipeline detects Phase 1 via git and memory)
$ bun run pipeline rust-plan-cycle ./my-project --plan ./plans/feature.md
# ... Memory provides context about Phase 1 ...
# ... Phase 2 continues with richer context ...
# Exit code: 0
```

---

## Troubleshooting

### "Resume detected but last phase commit not found"

**Cause**: Git log has Phase trailers but the commit is not found.

**Fix**:

1. Check git log:
   ```bash
   git log --oneline --grep="Phase:"
   ```

2. If commits are missing, manually reset:
   ```bash
   git reset --hard <known-good-commit>
   ```

3. Run the pipeline again

### "Working directory is dirty but reset failed"

**Cause**: Git reset failed (permission error, merge conflict, etc.).

**Fix**:

1. Check git status:
   ```bash
   git status
   ```

2. Manually resolve conflicts:
   ```bash
   git checkout -- .
   ```

3. Run the pipeline again

### "Resume skipped all phases"

**Cause**: The last phase number equals or exceeds the total number of phases.

**Fix**:

1. Check the plan file:
   ```bash
   grep "^## Phase" plans/feature.md
   ```

2. Verify the phase count matches the git log
3. Manually reset to an earlier phase if needed

### "Memory recall returns stale data"

**Cause**: Memory contains data from a previous run.

**Fix**:

1. Clear memory (if supported):
   ```bash
   # Cerebrum CLI command (if available)
   cerebrum-cli forget --all
   ```

2. Or ignore memory and rely on git-based resume
3. Or use a different session scope

---

## See Also

- [`README.md`](../README.md) — Quick start and pipeline overview
- [`docs/plan-cycle.md`](plan-cycle.md) — plan-cycle comprehensive guide
- [`docs/memory-client.md`](memory-client.md) — Cerebrum memory system details
