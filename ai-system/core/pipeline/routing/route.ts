import {
  EXTENSION_TO_TOOLCHAIN,
  TOOLCHAIN_DESCRIPTORS,
  type ToolchainDescriptor,
  buildPatchSystem,
} from "../definitions/language-configs";
import type { LanguageName } from "../plan-parser";

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
  const languageName: LanguageName | undefined = EXTENSION_TO_TOOLCHAIN[extension];
  if (languageName === undefined) {
    return null;
  }

  const descriptor = TOOLCHAIN_DESCRIPTORS[languageName as Exclude<LanguageName, "docs">];
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

  for (const [extension, languageName] of Object.entries(EXTENSION_TO_TOOLCHAIN)) {
    const descriptor = TOOLCHAIN_DESCRIPTORS[languageName as Exclude<LanguageName, "docs">];
    if (isAvailable(descriptor, palette)) {
      extensions.add(extension);
    }
  }

  return Array.from(extensions);
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

  const languageHint =
    availableDescriptors.length > 0
      ? availableDescriptors.map((descriptor) => descriptor.languageHint).join("/")
      : "general-purpose";

  const idioms = [
    ...availableDescriptors.map((descriptor) => descriptor.idioms),
    FLOOR_CLAUSE,
  ].join(" ");

  return buildPatchSystem(languageHint, idioms);
}
