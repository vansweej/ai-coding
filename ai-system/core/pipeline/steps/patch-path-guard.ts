import { isAbsolute, join, normalize } from "node:path";

/**
 * Error details when path safety validation fails.
 */
export interface PathSafetyError {
  readonly message: string;
}

/**
 * Validate that a target path is safe to access relative to a root directory.
 *
 * This guard rejects:
 *   - Absolute paths (e.g. `/etc/passwd`)
 *   - Paths that escape the root via `../` traversal (e.g. `../../etc/passwd`)
 *
 * On success, returns the resolved absolute path. On failure, returns a
 * `PathSafetyError` with a descriptive message.
 *
 * @param root - The root directory (workspace root) under which access is allowed.
 * @param target - The target path (relative or absolute) to validate.
 * @returns A `Result<string, PathSafetyError>` — the resolved absolute path on success,
 *          or an error on failure.
 */
export function assertInsideWorkspace(
  root: string,
  target: string,
): { ok: true; value: string } | { ok: false; error: PathSafetyError } {
  // Reject absolute paths
  if (isAbsolute(target)) {
    return {
      ok: false,
      error: {
        message: `Unsafe file path: "${target}" must be relative`,
      },
    };
  }

  // Resolve the target relative to root and normalize both paths
  const resolved = normalize(join(root, target));
  const normalizedRoot = normalize(root);

  // Ensure the resolved path is within the root (not escaped via ../)
  // The resolved path must start with the normalized root followed by a separator
  if (!resolved.startsWith(`${normalizedRoot}/`) && resolved !== normalizedRoot) {
    return {
      ok: false,
      error: {
        message: `Unsafe file path: "${target}" escapes the workspace root`,
      },
    };
  }

  return { ok: true, value: resolved };
}
