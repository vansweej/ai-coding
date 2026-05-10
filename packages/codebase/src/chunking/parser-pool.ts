import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Language, Parser } from "web-tree-sitter";

/**
 * Default directory where tree-sitter `.wasm` grammar files are stored.
 *
 * Overridable via the `AI_CODING_GRAMMARS_DIR` environment variable.
 * In production, this directory is populated by the home-manager Nix
 * activation script via `pkgs.fetchurl` derivations (see modules/grammars.nix).
 *
 * Grammar files follow the naming convention:
 *   `tree-sitter-<language>.wasm`
 *
 * For example:
 *   `~/.local/share/ai-coding/grammars/tree-sitter-typescript.wasm`
 */
export const DEFAULT_GRAMMARS_DIR = join(
  homedir(),
  ".local",
  "share",
  "ai-coding",
  "grammars",
);

/**
 * Manages a pool of `web-tree-sitter` Parser instances, one per language.
 *
 * Parsers are loaded lazily on first request and cached for the lifetime of
 * the pool. The WASM runtime is initialized once (on first `getParser()` call)
 * and shared across all parsers.
 *
 * Grammar files are loaded from `grammarsDir` using the naming convention:
 * `tree-sitter-<language>.wasm`
 *
 * ## Adding a new language
 * 1. Add the extension mapping in `discovery/detect-language.ts`.
 * 2. Add the AST node types in `chunking/node-extractors.ts`.
 * 3. Deploy the `.wasm` file via `home-manager switch` (see docs/codebase-indexer.md).
 *
 * @example
 * const pool = new ParserPool();
 * if (await pool.hasGrammar("typescript")) {
 *   const parser = await pool.getParser("typescript");
 *   const tree = parser.parse(sourceCode);
 * }
 */
export class ParserPool {
  private readonly grammarsDir: string;
  private readonly parsers = new Map<string, InstanceType<typeof Parser>>();
  private initialized = false;

  constructor(grammarsDir: string = process.env.AI_CODING_GRAMMARS_DIR ?? DEFAULT_GRAMMARS_DIR) {
    this.grammarsDir = grammarsDir;
  }

  /**
   * Check whether a grammar `.wasm` file exists for the given language.
   * Does not load or initialize the WASM runtime.
   *
   * @param language - Grammar name (e.g. `"typescript"`, `"rust"`).
   */
  hasGrammar(language: string): boolean {
    return existsSync(this.grammarPath(language));
  }

  /**
   * Return a fully initialized `Parser` for the given language.
   *
   * Initializes the WASM runtime on first call (idempotent).
   * Loads and caches the grammar on first request for that language.
   *
   * @param language - Grammar name (e.g. `"typescript"`, `"rust"`).
   * @throws If the grammar file does not exist or fails to load.
   */
  async getParser(language: string): Promise<InstanceType<typeof Parser>> {
    const cached = this.parsers.get(language);
    if (cached !== undefined) return cached;

    await this.ensureInitialized();

    const wasmPath = this.grammarPath(language);
    if (!existsSync(wasmPath)) {
      throw new Error(
        `Grammar not found for language "${language}": ${wasmPath}\n` +
          `Run home-manager switch to deploy grammars, or set AI_CODING_GRAMMARS_DIR.`,
      );
    }

    const lang = await Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(lang);
    this.parsers.set(language, parser);
    return parser;
  }

  /** Absolute path to the `.wasm` file for the given language. */
  grammarPath(language: string): string {
    return join(this.grammarsDir, `tree-sitter-${language}.wasm`);
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    // Locate the core tree-sitter.wasm bundled with web-tree-sitter
    const wasmPath = join(
      import.meta.dir,
      "..",
      "..",
      "node_modules",
      "web-tree-sitter",
      "tree-sitter.wasm",
    );
    await Parser.init({
      locateFile: () => wasmPath,
    });
    this.initialized = true;
  }
}
