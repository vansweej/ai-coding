import { execSync } from "node:child_process";
import type { PipelineStep } from "@ai-coding/pipeline";
import type { AIRequestEvent } from "@ai-coding/shared";

import {
  EXTENSION_TO_TOOLCHAIN,
  TOOLCHAIN_DESCRIPTORS,
  type ToolchainDescriptor,
  type ToolchainId,
  buildPatchSystem,
} from "../definitions/language-configs";
import type { CoverageDirective } from "../plan-parser";

/** Extensions that are always eligible for context/prompt inclusion regardless of palette. */
const ALWAYS_INCLUDED_EXTENSIONS: readonly string[] = [".md"];

/**
 * Clause appended to {@link composeImplementSystem}'s prompt describing the
 * no-toolchain floor: any file extension with no available toolchain (e.g.
 * `.md`, `.toml`, `.json`, `.yaml`, `.yml`, `.lock`, or a registered
 * extension whose driver tool is absent from the devShell) is edit-only --
 * apply the requested change verbatim, without running any compiler,
 * linter, or test.
 */
const FLOOR_CLAUSE =
  "Files with no matching toolchain (e.g. .md, .toml, .json, .yaml, .yml, .lock, or any " +
  "extension whose toolchain is unavailable in this devShell) are EDIT-ONLY: apply the " +
  "requested change verbatim; do not assume any compiler, linter, or test will run against them.";

/**
 * Returns true when at least one of `descriptor`'s driver tools is present
 * in the workspace's devShell palette, i.e. the toolchain is actually usable.
 */
function isAvailable(descriptor: ToolchainDescriptor, palette: ReadonlySet<string>): boolean {
  return descriptor.driverTools.some((tool) => palette.has(tool));
}

/**
 * Routes a single file to the toolchain descriptor responsible for
 * verifying it, given the tools actually detected in the workspace's
 * devShell (see {@link devShellPalette} in `@ai-coding/pipeline`).
 *
 * Returns `null` -- the no-toolchain FLOOR -- when either:
 *   - the file's extension has no registered toolchain (e.g. `.md`), or
 *   - the file's extension maps to a toolchain, but that toolchain's driver
 *     tool is not present in `palette` (the devShell doesn't provide it).
 *
 * Pure function: no I/O, no side effects. Extension matching is
 * case-insensitive and includes the full multi-part suffix a path ends
 * with (e.g. `foo.test.ts` still resolves via its final `.ts` extension).
 *
 * @param filePath - Path (relative or absolute) to the file being routed.
 * @param palette  - Set of tool names detected as available in the devShell.
 */
export function route(filePath: string, palette: ReadonlySet<string>): ToolchainDescriptor | null {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filePath.length - 1) {
    return null;
  }

  const extension = filePath.slice(lastDot).toLowerCase();
  const toolchainId: ToolchainId | undefined = EXTENSION_TO_TOOLCHAIN[extension];
  if (toolchainId === undefined) {
    return null;
  }

  const descriptor = TOOLCHAIN_DESCRIPTORS[toolchainId];
  if (!isAvailable(descriptor, palette)) {
    return null;
  }

  return descriptor;
}

/**
 * Returns the set of file extensions worth collecting as source context for
 * a workspace, given its devShell palette: every extension mapped to a
 * toolchain whose driver tool is present, plus `.md` (always included --
 * documentation phases conventionally touch README.md regardless of which
 * code toolchains are available).
 *
 * Pure function: no I/O. Order is not significant; callers should treat the
 * result as a set.
 *
 * @param palette - Set of tool names detected as available in the devShell.
 */
export function paletteExtensions(palette: ReadonlySet<string>): readonly string[] {
  const extensions = new Set<string>(ALWAYS_INCLUDED_EXTENSIONS);

  for (const [extension, toolchainId] of Object.entries(EXTENSION_TO_TOOLCHAIN)) {
    const descriptor = TOOLCHAIN_DESCRIPTORS[toolchainId];
    if (isAvailable(descriptor, palette)) {
      extensions.add(extension);
    }
  }

  return Array.from(extensions);
}

/**
 * Returns a human-readable hint naming every toolchain available in the
 * workspace's devShell palette (e.g. "Rust/TypeScript"), or "general-purpose"
 * when none are available. Used both by {@link composeImplementSystem}'s
 * opening sentence and by callers building a display-only instruction
 * preamble (e.g. "Implement this <hint> step.").
 *
 * @param palette - Set of tool names detected as available in the devShell.
 */
export function paletteLanguageHint(palette: ReadonlySet<string>): string {
  const availableDescriptors = Object.values(TOOLCHAIN_DESCRIPTORS).filter((descriptor) =>
    isAvailable(descriptor, palette),
  );

  return availableDescriptors.length > 0
    ? availableDescriptors.map((descriptor) => descriptor.languageHint).join("/")
    : "general-purpose";
}

/**
 * Composes ONE aider-style SEARCH/REPLACE system prompt covering every
 * toolchain available in the workspace's devShell, per the read-don't-declare
 * design (memory 4c40518b): the implement prompt cannot be routed per-file
 * without the plan pre-declaring file->language (a rejected knob), so instead
 * it is composed ONCE per workspace from the union of idioms for whichever
 * toolchains the devShell actually provides.
 *
 * When no registered toolchain is available (an empty or unrecognised
 * devShell), the prompt still includes the floor clause so the model knows
 * non-code files remain editable.
 *
 * @param palette - Set of tool names detected as available in the devShell.
 */
export function composeImplementSystem(palette: ReadonlySet<string>): string {
  const availableDescriptors = Object.values(TOOLCHAIN_DESCRIPTORS).filter((descriptor) =>
    isAvailable(descriptor, palette),
  );

  const idioms = [
    ...availableDescriptors.map((descriptor) => descriptor.idioms),
    FLOOR_CLAUSE,
  ].join(" ");

  return buildPatchSystem(paletteLanguageHint(palette), idioms);
}

/**
 * Returns paths of files touched in the workspace: the union of unstaged
 * changes (`git diff --name-only`) and staged changes
 * (`git diff --name-only --staged`), deduplicated. Used to scope union
 * verification to only the toolchains relevant to what actually changed, and
 * by phase-runner's lazy baseline attribution to detect whether any
 * whole-repo validator was implicated by the current phase.
 *
 * Silently returns an empty list when either git command fails (e.g. not a
 * git repository) -- verification simply has nothing to route, matching the
 * existing tolerant git-diff handling in `buildBaselineContext`.
 */
export function getTouchedFiles(workspace: string): readonly string[] {
  const files = new Set<string>();

  for (const command of ["git diff --name-only", "git diff --name-only --staged"]) {
    try {
      const output = execSync(command, { cwd: workspace, encoding: "utf8" });
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) files.add(trimmed);
      }
    } catch {
      // git not available, not a repository, or no commits yet -- no touched
      // files from this source; continue with whatever the other command found.
    }
  }

  return Array.from(files);
}

/**
 * Builds the verification steps for a phase by routing every touched file
 * (per {@link getTouchedFiles}) to its toolchain and taking the
 * DEDUPED-BY-STEP-NAME union of their `toolchainSteps`. Files that route to
 * the floor (see {@link route}) contribute nothing -- e.g. a docs-only
 * change produces an empty verification step list.
 *
 * When two routed toolchains happen to share a step name, the LAST toolchain
 * processed wins (Map.set semantics) -- in practice toolchains use disjoint
 * step names (fmt/check/clippy/test for Rust vs typecheck/lint/test for
 * TypeScript, etc.), so collisions are not expected in the current registry.
 *
 * `coverage`/`diff` are threaded through to each routed descriptor's
 * `toolchainSteps` (Rust is currently the only descriptor that uses them --
 * see `createRustPlanConfig`'s coverage-gating/tarpaulin-availability logic).
 * `palette` is passed through too, so a descriptor can additionally gate an
 * optional step on a specific tool's presence (not just its own driver
 * tools).
 *
 * @param workspace - Absolute path to the workspace being verified.
 * @param palette   - Set of tool names detected as available in the devShell.
 * @param coverage  - The phase's Coverage: directive, if any.
 * @param diff      - Current git diff, used for coverage auto-exemption.
 */
export function runUnionVerification(
  workspace: string,
  palette: ReadonlySet<string>,
  coverage?: CoverageDirective,
  diff?: string,
): readonly PipelineStep<AIRequestEvent>[] {
  const touchedFiles = getTouchedFiles(workspace);
  const stepsByName = new Map<string, PipelineStep<AIRequestEvent>>();

  for (const file of touchedFiles) {
    const descriptor = route(file, palette);
    if (descriptor === null) continue;

    for (const step of descriptor.toolchainSteps(workspace, coverage, diff, palette)) {
      stepsByName.set(step.name, step);
    }
  }

  return Array.from(stepsByName.values());
}
