import { isAbsolute, relative, resolve } from "node:path";

/**
 * Builds the argv array for a `git clean` invocation (verb included, callers
 * prepend only the `git` binary itself).
 *
 * Always excludes the `plans/` directory (`-e plans/`) so an on-disk
 * `--plan` file conventionally kept under `plans/` survives a working-tree
 * rollback. When `planPath` is provided and resolves to a location INSIDE
 * `repoRoot`, also excludes that specific path (`-e <repo-relative path>`) --
 * belt-and-suspenders for plan files kept outside the `plans/` convention.
 * When `planPath` is `undefined`, or resolves outside `repoRoot`, only the
 * blanket `plans/` guard is applied.
 *
 * This module is a deliberate LEAF: it must have ZERO pipeline-internal
 * imports (only `node:path`) so it can be safely imported by both
 * `phase-runner.ts` and `steps/structured-implement.ts` without
 * reintroducing the `structured-implement -> phase-runner` import cycle
 * those two files otherwise avoid by duplicating their restore logic.
 *
 * `-x` is deliberately NEVER added, so `.gitignore`d artifacts keep their
 * existing survive-behaviour.
 *
 * @param repoRoot - Absolute (or resolvable) path to the target repository root.
 * @param planPath - Optional path to the active `--plan` file to protect.
 * @returns A `readonly string[]` argv, e.g. `["clean", "-fd", "-e", "plans/"]`.
 */
export function buildGitCleanArgs(repoRoot: string, planPath?: string): readonly string[] {
  const args: string[] = ["clean", "-fd", "-e", "plans/"];

  if (planPath === undefined) {
    return args;
  }

  const resolvedRoot = resolve(repoRoot);
  const resolvedPlanPath = resolve(repoRoot, planPath);
  const relativePath = relative(resolvedRoot, resolvedPlanPath);

  const isInsideRepo =
    relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);

  if (isInsideRepo) {
    args.push("-e", relativePath.split("\\").join("/"));
  }

  return args;
}
