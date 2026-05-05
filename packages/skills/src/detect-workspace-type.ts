import { join } from "node:path";

import type { WorkspaceType } from "./skill-types";

/**
 * Marker files used to detect workspace project type.
 * Ordered by priority: Rust > C++ > TypeScript.
 * First match wins.
 */
const WORKSPACE_MARKERS: ReadonlyArray<{ readonly file: string; readonly type: WorkspaceType }> = [
  { file: "Cargo.toml", type: "rust" },
  { file: "CMakeLists.txt", type: "cpp" },
  { file: "package.json", type: "typescript" },
];

/**
 * Detect the project type of a workspace by probing for well-known marker files.
 *
 * Resolution order (first match wins):
 *   1. `Cargo.toml`     → "rust"
 *   2. `CMakeLists.txt` → "cpp"
 *   3. `package.json`   → "typescript"
 *   4. (no match)       → "unknown"
 *
 * When `workspace` is undefined, returns "unknown" immediately without any
 * filesystem access.
 *
 * @param workspace - Absolute path to the workspace directory, or undefined.
 * @returns The detected workspace type.
 */
export async function detectWorkspaceType(workspace: string | undefined): Promise<WorkspaceType> {
  if (workspace === undefined) {
    return "unknown";
  }

  for (const marker of WORKSPACE_MARKERS) {
    const markerPath = join(workspace, marker.file);
    if (await Bun.file(markerPath).exists()) {
      return marker.type;
    }
  }

  return "unknown";
}
