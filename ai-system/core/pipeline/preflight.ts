import type { PhaseAssertion } from "./phase-assertions";
import type { PlanFile } from "./plan-parser";

/**
 * Pure plan-preflight validation. Runs a small set of static rules over a
 * parsed `PlanFile` plus its raw text, before any model dispatch or
 * working-tree mutation, to catch plan defects that would otherwise only
 * surface after tokens are spent. This module performs NO I/O: the caller
 * injects a `fileExists` predicate. Every function here is pure and total
 * and never throws.
 *
 * Rules:
 *   - `assert-path-missing` (error): an Assert path (for kinds that require
 *     the file to be present) that is absent on disk AND never mentioned in
 *     any non-`Assert:` plan line — a defect, since no step creates/edits it.
 *   - `commit-message-normalized` (warn): the parser stripped a surrounding
 *     delimiter pair from the phase's commit message.
 *   - `anchor-ellipsis` (warn): a fenced anchor block whose nearest preceding
 *     non-blank cue line mentions locate/exact/search and whose body contains
 *     a literal ellipsis — likely an elided anchor. A JS spread is NOT flagged.
 *   - `step-without-edit-target` (warn): a non-verify-only step whose body
 *     has neither a fenced block nor a file-path-like token.
 */

/** Severity of a preflight violation. */
export type PreflightSeverity = "error" | "warn";

/** A single preflight rule violation. */
export interface PreflightViolation {
  /** Stable rule identifier. */
  readonly rule: string;
  /** Whether the violation is an error or a warning. */
  readonly severity: PreflightSeverity;
  /** The owning phase number, when cheaply derivable. */
  readonly phase?: number;
  /** Human-readable, single-line description. */
  readonly message: string;
}

/** The full set of violations found by a preflight run. */
export interface PreflightReport {
  /** All violations, in rule-evaluation order. */
  readonly violations: readonly PreflightViolation[];
}

/** Inputs to `runPreflight`: the parsed plan, its raw text, and a disk probe. */
export interface PreflightInput {
  /** The successfully parsed plan. */
  readonly plan: PlanFile;
  /** The raw plan text (same string passed to `parsePlanFile`). */
  readonly planText: string;
  /** Repo-relative existence probe injected by the caller (no I/O here). */
  readonly fileExists: (repoRelativePath: string) => boolean;
}

/** Assertion kinds whose target file must exist for the Assert to pass. */
const PATH_REQUIRING_KINDS: ReadonlySet<PhaseAssertion["kind"]> = new Set([
  "contains",
  "not-contains",
  "exists",
  "matches",
  "toml-keys",
  "test-passes",
]);

/** The repo-relative path addressed by an assertion (every kind has one). */
function assertionPath(assertion: PhaseAssertion): string {
  return assertion.path;
}

/** True when `path` (ignoring a leading `./`) appears on any non-`Assert:` plan line. */
function pathMentionedOutsideAsserts(path: string, planText: string): boolean {
  const needle = path.startsWith("./") ? path.slice(2) : path;
  for (const line of planText.split("\n")) {
    if (/^\s*Assert:/.test(line)) continue;
    if (line.includes(needle)) return true;
  }
  return false;
}

/** True when a fenced-block body contains a literal ellipsis that is NOT a JS spread. */
function hasElidingEllipsis(body: string): boolean {
  const ellipsis = String.fromCodePoint(0x2026);
  if (body.includes(ellipsis)) return true;
  let at = body.indexOf("...");
  while (at !== -1) {
    const next = body.charAt(at + 3);
    if (!/[A-Za-z_[({]/.test(next)) return true;
    at = body.indexOf("...", at + 3);
  }
  return false;
}

/** A cue line marks the fenced block below it as an anchor block. */
function isAnchorCueLine(line: string): boolean {
  return /locate|exact|search/i.test(line);
}

/**
 * Scan the plan text for fenced blocks whose nearest preceding NON-BLANK
 * line is an anchor cue line. Returns each such block's body.
 */
function anchorFencedBlocks(planText: string): readonly string[] {
  const fence = "`".repeat(3);
  const lines = planText.split("\n");
  const blocks: string[] = [];
  let inFence = false;
  let fenceIsAnchor = false;
  let bodyLines: string[] = [];
  let lastNonBlank = "";
  for (const line of lines) {
    if (line.trimStart().startsWith(fence)) {
      if (!inFence) {
        inFence = true;
        fenceIsAnchor = isAnchorCueLine(lastNonBlank);
        bodyLines = [];
      } else {
        if (fenceIsAnchor) blocks.push(bodyLines.join("\n"));
        inFence = false;
        fenceIsAnchor = false;
      }
      continue;
    }
    if (inFence) {
      bodyLines.push(line);
      continue;
    }
    if (line.trim().length > 0) lastNonBlank = line;
  }
  return blocks;
}

/** True when a step body contains at least one triple-backtick fenced block. */
function bodyHasFence(body: string): boolean {
  return body.includes("`".repeat(3));
}

/** True when a step body contains a file-path-like token (`name.ext`). */
function bodyHasPathToken(body: string): boolean {
  return /[\w./-]+\.[A-Za-z0-9]+/.test(body);
}

/**
 * Run the preflight rule set over a parsed plan. Pure; never throws.
 *
 * @param input - The parsed plan, its raw text, and a disk-existence probe.
 * @returns A report listing every rule violation found.
 */
export function runPreflight(input: PreflightInput): PreflightReport {
  const violations: PreflightViolation[] = [];

  for (const phase of input.plan.phases) {
    if (phase.commitMessageNormalized === true) {
      violations.push({
        rule: "commit-message-normalized",
        severity: "warn",
        phase: phase.number,
        message: `Phase ${phase.number} commit message had surrounding delimiters stripped; verify the result: ${phase.commitMessage}`,
      });
    }

    for (const assertion of phase.assertions ?? []) {
      if (!PATH_REQUIRING_KINDS.has(assertion.kind)) continue;
      const path = assertionPath(assertion);
      if (input.fileExists(path)) continue;
      if (pathMentionedOutsideAsserts(path, input.planText)) continue;
      violations.push({
        rule: "assert-path-missing",
        severity: "error",
        phase: phase.number,
        message: `Phase ${phase.number} asserts on "${path}" (kind ${assertion.kind}) but that path is absent on disk and mentioned by no step`,
      });
    }

    if (phase.verifyOnly === true) continue;
    for (const step of phase.steps) {
      if (bodyHasFence(step.body) || bodyHasPathToken(step.body)) continue;
      violations.push({
        rule: "step-without-edit-target",
        severity: "warn",
        phase: phase.number,
        message: `Phase ${phase.number} step ${step.number} ("${step.title}") names no file and has no fenced edit block`,
      });
    }
  }

  for (const body of anchorFencedBlocks(input.planText)) {
    if (!hasElidingEllipsis(body)) continue;
    violations.push({
      rule: "anchor-ellipsis",
      severity: "warn",
      message:
        "An anchor block appears to contain an elided region (ellipsis); anchors must be byte-exact",
    });
  }

  return { violations };
}
