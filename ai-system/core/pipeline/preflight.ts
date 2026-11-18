import type { PhaseAssertion } from "./phase-assertions";
import { extractPlanEditPairs, simulatePlanEdits } from "./plan-edit-blocks";
import type { PlanFile } from "./plan-parser";
import { checkEditScope } from "./steps/edit-scope-guard";

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
 *   - `anchor-not-found` / `anchor-not-unique` (warn): an extracted OLD/NEW
 *     edit pair whose OLD anchor resolves to zero / more than one site in the
 *     sequentially simulated virtual tree (requires an injected `readFile`).
 *   - `plan-conflicts-with-guard` (warn): an extracted edit pair whose OLD/NEW
 *     bodies would trip the apply-time edit-scope guard.
 *   - `fragile-assert` (warn): a `contains`/`not-contains` needle that looks
 *     fragile (multi-field struct, long signature, multi-item import list, or
 *     non-ASCII).
 *   - `assert-needle-unsourced` (warn): a `contains` needle produced by no plan
 *     NEW block and absent from the current file (requires `readFile`).
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
  /**
   * Optional repo-relative content probe. Returns the file's text, or
   * `undefined` when absent or unreadable. Rules that need file content are
   * skipped when this is not supplied, so the existing call shape keeps
   * working. No I/O happens in this module; the caller injects the reader.
   */
  readonly readFile?: (repoRelativePath: string) => string | undefined;
}

/** Assertion kinds whose target file must exist for the Assert to pass. */
const PATH_REQUIRING_KINDS: ReadonlySet<PhaseAssertion["kind"]> = new Set([
  "contains",
  "not-contains",
  "not-contains-outside-tests",
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

/** True when a `contains`/`not-contains` needle looks fragile to anchor on. */
function isFragileNeedle(needle: string): boolean {
  if (/\b[A-Z]\w*\s*\{[^}]*:[^}]*,[^}]*:/.test(needle)) return true;
  if ((needle.includes("fn ") || needle.includes("function ")) && needle.length > 60) return true;
  if (/\b(use|import)\b[^\n]*\{[^}]*,[^}]*\}/.test(needle)) return true;
  for (const ch of needle) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code > 127) return true;
  }
  return false;
}

/** Collect the NEW-block bodies in the plan that target `filePath`. */
function newBlocksForPath(plan: PlanFile, filePath: string): readonly string[] {
  const bodies: string[] = [];
  for (const pair of extractPlanEditPairs(plan)) {
    if (pair.filePath === filePath) bodies.push(pair.newText);
  }
  return bodies;
}

/** `fragile-assert` and `assert-needle-unsourced` warnings over contains-family asserts. */
function fragileAssertViolations(
  input: PreflightInput,
  readFile: ((repoRelativePath: string) => string | undefined) | undefined,
): readonly PreflightViolation[] {
  const violations: PreflightViolation[] = [];
  for (const phase of input.plan.phases) {
    for (const assertion of phase.assertions ?? []) {
      if (assertion.kind !== "contains" && assertion.kind !== "not-contains") continue;
      const needle = assertion.needle;
      if (isFragileNeedle(needle)) {
        violations.push({
          rule: "fragile-assert",
          severity: "warn",
          phase: phase.number,
          message: `Phase ${phase.number} ${assertion.kind} needle on "${assertion.path}" is fragile (formatter or regeneration may break it); prefer a short, distinctive single-line token`,
        });
      }
      if (assertion.kind !== "contains" || readFile === undefined) continue;
      const inNewBlock = newBlocksForPath(input.plan, assertion.path).some((b) =>
        b.includes(needle),
      );
      if (inNewBlock) continue;
      const onDisk = readFile(assertion.path);
      if (onDisk === undefined) continue;
      if (onDisk.includes(needle)) continue;
      violations.push({
        rule: "assert-needle-unsourced",
        severity: "warn",
        phase: phase.number,
        message: `Phase ${phase.number} contains needle on "${assertion.path}" appears in no plan NEW block and is absent from the current file; it may never be produced`,
      });
    }
  }
  return violations;
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

  const readFile = input.readFile;
  if (readFile !== undefined) {
    const pairs = extractPlanEditPairs(input.plan);
    const simulation = simulatePlanEdits(pairs, readFile);
    for (const v of simulation.violations) {
      violations.push({
        rule: v.rule,
        severity: "warn",
        phase: v.phase,
        message: `Phase ${v.phase} step ${v.step} anchor on "${v.filePath}" resolved to ${v.occurrences} site(s) in the simulated tree`,
      });
    }
    for (const pair of pairs) {
      if (pair.oldText.trim().length === 0) continue;
      const guard = checkEditScope(pair.oldText, pair.newText, pair.filePath);
      if (guard.ok) continue;
      violations.push({
        rule: "plan-conflicts-with-guard",
        severity: "warn",
        phase: pair.phase,
        message: `Phase ${pair.phase} step ${pair.step} edit to "${pair.filePath}" would trip the edit-scope guard [${guard.error.rule}]: ${guard.error.message}`,
      });
    }
  }

  for (const violation of fragileAssertViolations(input, readFile)) {
    violations.push(violation);
  }

  return { violations };
}
