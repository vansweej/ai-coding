import type { PlanFile } from "./plan-parser";

/** A single OLD/NEW edit pair extracted from one plan step. */
export interface PlanEditPair {
  /** Repo-relative target path resolved for this pair. */
  readonly filePath: string;
  /** Verbatim OLD (anchor) text: the fenced body under the OLD cue. */
  readonly oldText: string;
  /** Verbatim NEW text: the fenced body under the NEW cue. */
  readonly newText: string;
  /** Owning phase number (1-indexed). */
  readonly phase: number;
  /** Owning step number (1-indexed). */
  readonly step: number;
}

/** A simulation violation: an anchor that did not resolve to exactly one site. */
export interface SimulationViolation {
  /** Stable rule id: anchor missing, or not unique in the current content. */
  readonly rule: "anchor-not-found" | "anchor-not-unique";
  readonly phase: number;
  readonly step: number;
  readonly filePath: string;
  /** Occurrence count of oldText in the current virtual content. */
  readonly occurrences: number;
}

/** Result of simulating every extracted pair in plan order. */
export interface SimulationResult {
  readonly pairs: readonly PlanEditPair[];
  readonly violations: readonly SimulationViolation[];
}

interface FencedBlock {
  readonly body: string;
  readonly nextLine: number;
}

function nextNonBlank(lines: readonly string[], start: number): number {
  let index = start;
  while (index < lines.length && lines[index].trim().length === 0) index++;
  return index;
}

function readFence(lines: readonly string[], start: number): FencedBlock | undefined {
  const opening = /^\s*(`{3,})(?:[^`]*)$/.exec(lines[start] ?? "");
  if (!opening) return undefined;
  const fence = opening[1];
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].trim() === fence) return { body: body.join("\n"), nextLine: index + 1 };
    body.push(lines[index]);
  }
  return undefined;
}

function cuePath(line: string): string | undefined {
  return /`([^`]+)`/.exec(line)?.[1];
}

function inferredPath(body: string): string | undefined {
  const paths = new Set(body.match(/[\w./-]+\.[A-Za-z0-9]+/g) ?? []);
  return paths.size === 1 ? paths.values().next().value : undefined;
}

/**
 * Extract every OLD/NEW edit pair from the plan, in phase-then-step order.
 * See isOldCueLine/isNewCueLine for the cue shapes; the fenced block after a
 * cue closes only on a fence line with the same backtick count. Path
 * resolution: OLD cue path, else NEW cue path, else the single distinct
 * repo-relative path token in the step body, else the pair is skipped.
 * Never throws.
 */
export function extractPlanEditPairs(plan: PlanFile): readonly PlanEditPair[] {
  try {
    const pairs: PlanEditPair[] = [];
    for (const phase of plan.phases) {
      for (const step of phase.steps) {
        const lines = step.body.split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (!isOldCueLine(lines[index])) {
            const block = readFence(lines, index);
            if (block) index = block.nextLine - 1;
            continue;
          }
          const oldCue = lines[index];
          const oldBlock = readFence(lines, nextNonBlank(lines, index + 1));
          if (!oldBlock) continue;
          const newCueIndex = nextNonBlank(lines, oldBlock.nextLine);
          const newCue = lines[newCueIndex];
          if (newCue === undefined || !isNewCueLine(newCue)) {
            index = oldBlock.nextLine - 1;
            continue;
          }
          const newBlock = readFence(lines, nextNonBlank(lines, newCueIndex + 1));
          if (!newBlock) {
            index = oldBlock.nextLine - 1;
            continue;
          }
          const filePath = cuePath(oldCue) ?? cuePath(newCue) ?? inferredPath(step.body);
          if (filePath !== undefined) {
            pairs.push({
              filePath,
              oldText: oldBlock.body,
              newText: newBlock.body,
              phase: phase.number,
              step: step.number,
            });
          }
          index = newBlock.nextLine - 1;
        }
      }
    }
    return pairs;
  } catch {
    return [];
  }
}

/** True for an OLD anchor cue line: `OLD:` or OLD followed by a backticked path and a colon. */
export function isOldCueLine(line: string): boolean {
  try {
    return /^OLD(?:\s*\(`[^`]+`\))?:$/.test(line.trim());
  } catch {
    return false;
  }
}

/** True for a NEW replacement cue line: a trimmed line starting with `NEW` and ending with `:`. */
export function isNewCueLine(line: string): boolean {
  try {
    const trimmed = line.trim();
    return trimmed.startsWith("NEW") && trimmed.endsWith(":");
  } catch {
    return false;
  }
}

/**
 * Simulate every extracted pair over a virtual file map seeded lazily via
 * readFile (called at most once per path). For each pair count occurrences
 * of oldText in the current virtual content: 0 -> anchor-not-found, more
 * than 1 -> anchor-not-unique (content unchanged in both cases), exactly 1 ->
 * replace that occurrence with newText so later steps and phases observe the
 * edit. A pair whose file is absent (readFile returns undefined) and whose
 * oldText is blank is a CREATE: the virtual content becomes newText. A blank
 * oldText on an existing file counts as anchor-not-found. Never throws.
 */
export function simulatePlanEdits(
  pairs: readonly PlanEditPair[],
  readFile: (path: string) => string | undefined,
): SimulationResult {
  try {
    const files = new Map<string, string | undefined>();
    const violations: SimulationViolation[] = [];
    for (const pair of pairs) {
      if (!files.has(pair.filePath)) files.set(pair.filePath, readFile(pair.filePath));
      const content = files.get(pair.filePath);
      if (content === undefined && pair.oldText.trim().length === 0) {
        files.set(pair.filePath, pair.newText);
        continue;
      }
      let occurrences = 0;
      let firstIndex = -1;
      if (content !== undefined && pair.oldText.trim().length > 0) {
        let index = content.indexOf(pair.oldText);
        while (index !== -1) {
          if (firstIndex === -1) firstIndex = index;
          occurrences++;
          index = content.indexOf(pair.oldText, index + pair.oldText.length);
        }
      }
      if (occurrences !== 1 || content === undefined) {
        violations.push({
          rule: occurrences === 0 ? "anchor-not-found" : "anchor-not-unique",
          phase: pair.phase,
          step: pair.step,
          filePath: pair.filePath,
          occurrences,
        });
      } else {
        files.set(
          pair.filePath,
          content.slice(0, firstIndex) +
            pair.newText +
            content.slice(firstIndex + pair.oldText.length),
        );
      }
    }
    return { pairs, violations };
  } catch {
    return { pairs: [], violations: [] };
  }
}
