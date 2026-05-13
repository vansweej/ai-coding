import { join } from "node:path";

/** Marker filename that exempts its containing directory from TTL eviction. */
export const KEEP_MARKER = ".ai-coding-keep";

/**
 * Extensions and filenames that are never worth indexing for code retrieval.
 * These are binary assets, generated artifacts, or metadata files that have
 * no semantic value to the agent.
 */
const SKIP_EXTENSIONS = new Set([
  // ── images ────────────────────────────────────────────────────────────────
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  // ── additional texture / HDR formats (e.g. GeometricTools samples) ────────
  ".bmp",
  ".tga",
  ".dds",
  ".hdr",
  ".exr",
  ".tiff",
  ".tif",
  // ── compiled / binary artifacts ───────────────────────────────────────────
  ".wasm",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".lock",
  ".bin",
  ".exe",
  ".so",
  ".dylib",
  ".a",
  ".o",
  // ── raw binary data files (e.g. GeometricTools terrain heightmaps) ────────
  ".binary",
  // ── Visual Studio build system files — XML noise, no semantic value ───────
  ".sln",
  ".vcxproj",
  ".natvis",
  // ── font binaries ─────────────────────────────────────────────────────────
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  // ── audio / video ─────────────────────────────────────────────────────────
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".webm",
]);

/**
 * Compound suffixes that cannot be caught by single-extension matching.
 * Checked against the full filename (not just the last dot segment).
 */
const SKIP_SUFFIXES = new Set([
  ".vcxproj.filters", // Visual Studio project filter files
]);

const SKIP_FILENAMES = new Set([
  "bun.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "flake.lock",
]);

/**
 * Discover all indexable source files in a git repository.
 *
 * Uses `git ls-files` to enumerate tracked files, which automatically
 * respects `.gitignore` and only returns committed or staged files.
 * Untracked files are intentionally excluded — they will appear after the
 * next `git add`.
 *
 * Binary files and known non-code files (images, lockfiles, compiled
 * artifacts) are filtered out. The returned paths are relative to `repoRoot`.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @returns Relative file paths suitable for passing to the chunker.
 * @throws If `git ls-files` fails (e.g. `repoRoot` is not a git repository).
 *
 * @example
 * const files = await discoverFiles("/Users/dev/myproject");
 * // ["src/main.ts", "src/lib.rs", "README.md", ...]
 */
export async function discoverFiles(repoRoot: string): Promise<readonly string[]> {
  // Validate that repoRoot is actually a git repository before listing files
  const checkProc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const checkExit = await checkProc.exited;
  if (checkExit !== 0) {
    throw new Error(`git ls-files failed in ${repoRoot}: not a git repository`);
  }

  const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    /* v8 ignore start */
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`git ls-files failed in ${repoRoot}: ${stderr.trim()}`);
    /* v8 ignore stop */
  }

  const allFiles = stdout
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);

  return allFiles.filter((filePath) => !shouldSkip(filePath));
}

/**
 * Discover directory prefixes that should be exempt from TTL eviction.
 *
 * This is a pure pass over the already-discovered file list, avoiding extra
 * filesystem I/O. A marker at the repository root would exempt every row, so it
 * is ignored with a warning.
 *
 * @param files - Relative file paths returned by {@link discoverFiles}.
 * @returns Directory prefixes with trailing slash, e.g. `["GeometricTools/"]`.
 */
export function discoverKeepDirs(files: readonly string[]): readonly string[] {
  const keepDirs = new Set<string>();

  for (const filePath of files) {
    if (!filePath.endsWith(KEEP_MARKER)) continue;

    const markerIndex = filePath.lastIndexOf(`/${KEEP_MARKER}`);
    if (markerIndex === -1) {
      console.warn(`⚠️   Ignoring root-level ${KEEP_MARKER}; it would exempt the entire repo.`);
      continue;
    }

    keepDirs.add(`${filePath.slice(0, markerIndex)}/`);
  }

  return Array.from(keepDirs).sort();
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true if the file should be excluded from indexing.
 *
 * Checks in order:
 *   1. Exact filename match (e.g. `bun.lock`)
 *   2. Compound suffix match (e.g. `.vcxproj.filters`)
 *   3. Single-extension match (e.g. `.png`, `.sln`)
 */
function shouldSkip(filePath: string): boolean {
  const filename = filePath.split("/").pop() ?? filePath;

  if (SKIP_FILENAMES.has(filename)) return true;

  for (const suffix of SKIP_SUFFIXES) {
    if (filename.endsWith(suffix)) return true;
  }

  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return false;

  const ext = filename.slice(dotIndex).toLowerCase();
  return SKIP_EXTENSIONS.has(ext);
}

/**
 * Resolve a relative file path to an absolute path within the repo.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param relativePath - Relative path as returned by `discoverFiles`.
 * @returns Absolute path to the file.
 */
export function resolveFilePath(repoRoot: string, relativePath: string): string {
  return join(repoRoot, relativePath);
}
