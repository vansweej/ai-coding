import { extname } from "node:path";

/**
 * Maps file extensions to tree-sitter grammar names.
 *
 * The grammar name corresponds to the `.wasm` file basename without the
 * `tree-sitter-` prefix and `.wasm` suffix — e.g. `typescript` maps to
 * `tree-sitter-typescript.wasm` in the grammars directory.
 *
 * Returns `null` for extensions with no tree-sitter grammar, which triggers
 * the fallback paragraph-based chunker.
 *
 * ## Adding a new language
 * 1. Add the extension → grammar name entry here.
 * 2. Add the AST node type entry in `chunking/node-extractors.ts`.
 * 3. Add the `pkgs.fetchurl` entry for the `.wasm` file in the home-manager
 *    Nix configuration (see `modules/grammars.nix`).
 * 4. Run `home-manager switch` to deploy the grammar.
 */
const EXT_TO_LANG: Readonly<Record<string, string>> = {
  // TypeScript / JavaScript
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  // Rust
  ".rs": "rust",
  // C / C++
  ".c": "c",
  ".h": "cpp", // headers use C++ grammar — superset of C, handles templates/classes/namespaces
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  // Python
  ".py": "python",
  // Haskell (future — grammar not yet deployed)
  ".hs": "haskell",
  ".lhs": "haskell",
  // Lua (future — grammar not yet deployed)
  ".lua": "lua",
  // Julia (future — grammar not yet deployed)
  ".jl": "julia",
};

/**
 * Detect the tree-sitter grammar name for a given file path.
 *
 * @param filePath - Absolute or relative file path.
 * @returns Grammar name (e.g. `"typescript"`) or `null` if no grammar exists.
 *
 * @example
 * detectLanguage("src/store/lance-store.ts") // "typescript"
 * detectLanguage("Cargo.toml")               // null  (uses fallback chunker)
 * detectLanguage("src/lib.rs")               // "rust"
 */
export function detectLanguage(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}
