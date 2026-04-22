/**
 * Pipeline registry — single source of truth for all pipeline metadata.
 *
 * Adding a new pipeline requires only one change: a new entry here.
 * The CLI and OpenCode tool both derive their pipeline lists from this registry.
 */

/** Metadata describing a registered pipeline. */
export interface PipelineEntry {
  /** CLI name used with `bun run pipeline <name>`. */
  readonly name: string;
  /** One-line description shown in help text. */
  readonly description: string;
  /** Tech stack / language the pipeline targets. */
  readonly stack: string;
}

/** All registered pipelines, in display order. */
export const PIPELINE_REGISTRY: readonly PipelineEntry[] = [
  {
    name: "dev-cycle",
    description: "plan → implement → write-files → test",
    stack: "TypeScript",
  },
  {
    name: "rust-dev-cycle",
    description: "plan → implement → write-files → fmt → clippy → test → coverage",
    stack: "Rust",
  },
  {
    name: "cmake-dev-cycle",
    description: "plan → implement → write-files → configure → build → test",
    stack: "C++",
  },
  {
    name: "scaffold-rust",
    description: "cargo init + generate flake.nix",
    stack: "Rust",
  },
  {
    name: "scaffold-cpp",
    description: "generate CMakeLists.txt + src/main.cpp + flake.nix",
    stack: "C++",
  },
];

/** Set of all registered pipeline names for fast lookup. */
export const PIPELINE_NAMES: ReadonlySet<string> = new Set(
  PIPELINE_REGISTRY.map((entry) => entry.name),
);

/**
 * Look up a pipeline entry by name.
 *
 * @param name - The pipeline CLI name.
 * @returns The matching entry, or undefined if not found.
 */
export function findPipelineEntry(name: string): PipelineEntry | undefined {
  return PIPELINE_REGISTRY.find((entry) => entry.name === name);
}
