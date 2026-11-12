import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Minimal typed shape returned by `cargo metadata --format-version 1 --no-deps`. */
export interface CargoMetadata {
  /** Absolute root directory of the Cargo workspace. */
  readonly workspace_root: string;
  /** Package IDs declared as workspace members. */
  readonly workspace_members: readonly string[];
  /** Packages reported by Cargo metadata. */
  readonly packages: readonly CargoPackage[];
}

/** Minimal Cargo package shape needed to locate a package directory. */
export interface CargoPackage {
  /** Cargo's stable package identifier. */
  readonly id: string;
  /** Absolute path to the package's Cargo.toml manifest. */
  readonly manifest_path: string;
}

/**
 * Returns touched Rust paths outside every Cargo workspace member directory.
 *
 * This is a pure, fail-open advisory computation: callers can skip its result
 * when metadata is unavailable without changing verification outcomes.
 *
 * @param metadata - Parsed `cargo metadata --format-version 1 --no-deps` output.
 * @param touchedFiles - Repo-relative paths touched by the current phase.
 * @param workspacePath - Absolute path to the workspace being verified.
 * @returns Touched `.rs` paths not contained by a workspace member package.
 */
export function computeUncoveredRustFiles(
  metadata: CargoMetadata,
  touchedFiles: readonly string[],
  workspacePath: string,
): readonly string[] {
  const memberIds = new Set(metadata.workspace_members);
  const memberDirectories = metadata.packages
    .filter((pkg) => memberIds.has(pkg.id))
    .map((pkg) => dirname(resolve(workspacePath, pkg.manifest_path)));

  return touchedFiles.filter((touchedFile) => {
    if (!touchedFile.endsWith(".rs")) return false;

    const absoluteTouchedPath = resolve(workspacePath, touchedFile);
    return !memberDirectories.some((memberDirectory) => {
      const pathFromMember = relative(memberDirectory, absoluteTouchedPath);
      return (
        pathFromMember === "" ||
        (pathFromMember !== ".." &&
          !pathFromMember.startsWith(`..${sep}`) &&
          !isAbsolute(pathFromMember))
      );
    });
  });
}
