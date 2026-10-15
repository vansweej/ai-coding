import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { getTouchedFiles } from "../routing/route";

/** Default total character budget across all selected files. */
export const DEFAULT_CONTEXT_CHAR_BUDGET = 120_000;

/** Default per-file character cap before truncation. */
export const DEFAULT_PER_FILE_CHAR_CAP = 40_000;

const GENERATED_BASENAMES = new Set<string>([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "flake.lock",
]);

/**
 * Whether a repo-relative path is a generated/lock artifact that should never
 * be auto-selected as touched context: a known lockfile basename, or any path
 * with a `node_modules/` segment. Instruction-referenced files bypass this.
 */
export function isGeneratedPath(rel: string): boolean {
  if (GENERATED_BASENAMES.has(basename(rel))) return true;
  const segments = rel.split("/");
  return segments.includes("node_modules");
}

/**
 * Marker appended to a file body truncated at the per-file cap. Deliberately
 * free of ellipsis and comment syntax so a model echoing it is not mistaken
 * for an elision-placeholder comment by the P3 edit-scope guard.
 */
export function truncationMarker(droppedChars: number): string {
  return `\n[ai-coding: truncated ${droppedChars} chars]\n`;
}

/** Options controlling {@link renderBoundedFileContents} character budgets. */
export interface ContextBudget {
  /** Total character budget across all selected files. */
  readonly totalBudget?: number;
  /** Per-file character cap before truncation. */
  readonly perFileCap?: number;
}

/** Whether a repo-relative path resolves to a regular file inside the workspace. */
function isRegularFileInside(workspace: string, rel: string): boolean {
  if (isAbsolute(rel)) return false;
  const abs = resolve(workspace, rel);
  const rootPrefix = `${resolve(workspace)}/`;
  if (!abs.startsWith(rootPrefix)) return false;
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Deterministically collect repo-relative paths referenced verbatim in the
 * phase instruction. A path qualifies only when it resolves to a regular file
 * strictly inside the workspace; directories, absolute paths, and `..`
 * escapes are ignored. Trailing sentence punctuation is stripped from each
 * token first, so `src/x.ts.` resolves. Referenced files are returned even
 * when they are generated/lock artifacts (the author named them explicitly).
 */
export function referencedFiles(workspace: string, instruction: string): readonly string[] {
  const found = new Set<string>();
  for (const token of instruction.split(/[\s"'`()<>:,]+/)) {
    const trimmed = token.trim().replace(/[.;!?]+$/, "");
    if (trimmed.length === 0) continue;
    if (isRegularFileInside(workspace, trimmed)) {
      found.add(relative(workspace, resolve(workspace, trimmed)));
    }
  }
  return Array.from(found).sort();
}

/**
 * Select existing files for a retry prompt, ordered REFERENCED-FIRST: files
 * named in the instruction (sorted) come first, then the remaining touched
 * files (sorted), so a tight budget is spent on the named files first. Touched
 * files that are generated/lock artifacts are excluded; instruction-referenced
 * files are never excluded. All results are regular files inside the workspace.
 */
export function selectContextFiles(workspace: string, instruction: string): readonly string[] {
  const referenced = referencedFiles(workspace, instruction);
  const referencedSet = new Set(referenced);

  const touched: string[] = [];
  for (const rel of getTouchedFiles(workspace)) {
    if (referencedSet.has(rel)) continue;
    if (isGeneratedPath(rel)) continue;
    if (isRegularFileInside(workspace, rel)) touched.push(rel);
  }
  touched.sort();

  const ordered: string[] = [];
  for (const rel of referenced) {
    if (isRegularFileInside(workspace, rel)) ordered.push(rel);
  }
  for (const rel of touched) ordered.push(rel);
  return ordered;
}

/**
 * Render the selected files into a bounded "Current file contents:" block.
 * Returns an empty string when the selection is empty so callers can fall back
 * to prior behavior. Files are visited REFERENCED-FIRST; each is capped (with a
 * non-comment truncation marker) and the whole block stops once `totalBudget`
 * is consumed, so named files win the budget.
 */
export function renderBoundedFileContents(
  workspace: string,
  instruction: string,
  budget?: ContextBudget,
): string {
  const totalBudget = budget?.totalBudget ?? DEFAULT_CONTEXT_CHAR_BUDGET;
  const perFileCap = budget?.perFileCap ?? DEFAULT_PER_FILE_CHAR_CAP;
  const files = selectContextFiles(workspace, instruction);
  if (files.length === 0) return "";

  const parts: string[] = [];
  let used = 0;
  for (const rel of files) {
    if (used >= totalBudget) break;
    let content: string;
    try {
      content = readFileSync(resolve(workspace, rel), "utf8");
    } catch {
      continue;
    }
    if (content.length > perFileCap) {
      content = `${content.slice(0, perFileCap)}${truncationMarker(content.length - perFileCap)}`;
    }
    const block = `// ${rel}\n${content}`;
    parts.push(block);
    used += block.length;
  }

  if (parts.length === 0) return "";
  return `Current file contents:\n\n${parts.join("\n\n---\n\n")}`;
}
