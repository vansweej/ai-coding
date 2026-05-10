import type { Tree } from "web-tree-sitter";
import type { Node as SyntaxNode } from "web-tree-sitter";

import type { CodeChunk } from "../chunk-types";
import { splitOversized } from "./split-oversized";

/** Maximum characters per chunk before sub-splitting. */
const DEFAULT_MAX_CHUNK_CHARS = 3000;

/**
 * Maps language names to the AST node types that represent meaningful
 * chunk boundaries for code retrieval.
 *
 * Each entry is an array of tree-sitter node `type` strings for top-level
 * declarations that the agent would search for semantically. Only direct
 * children of the root node (or namespace/module nodes) are considered.
 *
 * ## Adding a new language
 * 1. Find the grammar's node types at https://github.com/nicolo-ribaudo/tree-sitter-<lang>
 *    or by running `tree-sitter parse` and inspecting the tree.
 * 2. Add an entry here with the node types that represent function/class/module
 *    boundaries in that language.
 * 3. Add the grammar `.wasm` and extension mapping as described in detect-language.ts.
 */
const CHUNK_NODES: Readonly<Record<string, readonly string[]>> = {
  typescript: [
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "export_statement",
    "lexical_declaration", // const/let at module level
    "variable_declaration", // var at module level
    "import_statement",
  ],
  javascript: [
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "export_statement",
    "lexical_declaration",
    "variable_declaration",
    "import_statement",
  ],
  rust: [
    "function_item",
    "impl_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "type_item",
    "const_item",
    "static_item",
    "macro_definition",
    "macro_invocation",
    "use_declaration",
    "mod_item",
  ],
  c: [
    "function_definition",
    "declaration",
    "struct_specifier",
    "enum_specifier",
    "type_definition",
    "preproc_include",
    "preproc_def",
    "preproc_function_def",
  ],
  cpp: [
    "function_definition",
    "declaration",
    "class_specifier",
    "struct_specifier",
    "enum_specifier",
    "namespace_definition",
    "type_definition",
    "template_declaration",
    "preproc_include",
    "preproc_def",
  ],
  python: [
    "function_definition",
    "async_function_definition",
    "class_definition",
    "decorated_definition",
    "import_statement",
    "import_from_statement",
    "assignment", // top-level constants
  ],
  haskell: [
    "function",
    "signature",
    "data_declaration",
    "newtype_declaration",
    "type_synonym_declaration",
    "class_declaration",
    "instance_declaration",
    "import",
    "module",
  ],
  lua: [
    "function_declaration",
    "local_function",
    "assignment_statement", // module-level assignments
    "local_variable_declaration",
  ],
  julia: [
    "function_definition",
    "short_function_definition",
    "struct_definition",
    "abstract_definition",
    "module_definition",
    "import_statement",
    "using_statement",
    "const_statement",
  ],
};

/**
 * Extract `CodeChunk[]` from a parsed tree-sitter AST.
 *
 * Walks the direct children of the root node (or of module/namespace nodes)
 * and emits one chunk per top-level declaration. Each chunk is prefixed with
 * a context header containing the file path and symbol name for self-contained
 * retrieval results.
 *
 * Oversized chunks (> maxChunkChars) are sub-split on blank lines, preserving
 * approximate line attribution.
 *
 * @param tree         - Parsed tree-sitter Tree.
 * @param source       - Original source text (used to extract node text).
 * @param repoId       - Canonical repo identifier.
 * @param filePath     - File path relative to the repo root.
 * @param language     - Tree-sitter grammar name (used to look up CHUNK_NODES).
 * @param maxChunkChars - Hard cap on chunk character count (default 3000).
 * @returns Ordered array of chunks ready for embedding.
 */
export function extractChunks(
  tree: Tree,
  source: string,
  repoId: string,
  filePath: string,
  language: string,
  maxChunkChars: number = DEFAULT_MAX_CHUNK_CHARS,
): readonly CodeChunk[] {
  const nodeTypes = new Set(CHUNK_NODES[language] ?? []);
  if (nodeTypes.size === 0) return [];

  const chunks: CodeChunk[] = [];
  const root = tree.rootNode;

  // Walk immediate children of the root (or module nodes)
  for (const child of root.children) {
    if (child !== null) {
      collectChunks(child, source, repoId, filePath, nodeTypes, chunks, maxChunkChars);
    }
  }

  return chunks;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively collect chunks from a node.
 * Recurses into namespace/module container nodes rather than emitting them as
 * a single chunk (they'd be too large and not semantically useful).
 */
function collectChunks(
  node: SyntaxNode,
  source: string,
  repoId: string,
  filePath: string,
  nodeTypes: Set<string>,
  chunks: CodeChunk[],
  maxChunkChars: number,
): void {
  if (!nodeTypes.has(node.type)) {
    // Recurse into container nodes (namespace, module, impl blocks)
    if (isContainerNode(node.type)) {
      for (const child of node.children) {
        if (child !== null) {
          collectChunks(child, source, repoId, filePath, nodeTypes, chunks, maxChunkChars);
        }
      }
    }
    return;
  }

  const symbolName = extractSymbolName(node);
  const symbolKind = node.type;
  const startLine = node.startPosition.row + 1; // tree-sitter rows are 0-based
  const endLine = node.endPosition.row + 1;
  const rawText = source.slice(node.startIndex, node.endIndex);

  const prefix = buildPrefix(filePath, symbolName, symbolKind);
  const fullText = `${prefix}\n\n${rawText}`.trim();

  if (fullText.length <= maxChunkChars) {
    chunks.push({
      repoId,
      filePath,
      symbolName,
      symbolKind,
      text: fullText,
      chunkIndex: chunks.length,
      startLine,
      endLine,
    });
    return;
  }

  // Sub-split oversized nodes using the shared three-tier splitter,
  // which guarantees every piece respects maxChunkChars.
  const parts = splitOversized(fullText, maxChunkChars);
  let currentStart = startLine;

  for (const part of parts) {
    const lines = part.split("\n").length;
    chunks.push({
      repoId,
      filePath,
      symbolName,
      symbolKind,
      text: part,
      chunkIndex: chunks.length,
      startLine: currentStart,
      endLine: currentStart + lines - 1,
    });
    currentStart += lines;
  }
}

/**
 * Attempt to extract the symbol name from common child field names.
 * Returns null if no named child is found.
 */
function extractSymbolName(node: SyntaxNode): string | null {
  // Try common field names used across languages
  const nameNode =
    node.childForFieldName("name") ??
    node.childForFieldName("declarator") ??
    node.childForFieldName("pattern");

  if (nameNode === null) return null;

  // For declarator nodes (C/C++), extract the identifier child
  if (nameNode.type === "function_declarator" || nameNode.type === "pointer_declarator") {
    const inner = nameNode.childForFieldName("declarator") ?? nameNode.firstNamedChild;
    /* v8 ignore next */
    return inner?.text ?? null;
  }

  return nameNode.text;
}

/**
 * Node types that act as containers for other declarations.
 * We recurse into these rather than emitting them as a single chunk.
 */
function isContainerNode(type: string): boolean {
  return (
    type === "namespace_definition" ||
    type === "mod_item" ||
    type === "module_definition" ||
    type === "program" ||
    type === "source_file" ||
    type === "translation_unit"
  );
}

/**
 * Build the context prefix prepended to every chunk for self-contained retrieval.
 * Example: `# file: src/store/lance-store.ts | class: LanceStore`
 */
function buildPrefix(filePath: string, symbolName: string | null, symbolKind: string): string {
  const kindLabel = symbolKind.replace(/_/g, " ").replace(/ item$| definition$| declaration$/, "");
  if (symbolName !== null) {
    return `# file: ${filePath} | ${kindLabel}: ${symbolName}`;
  }
  return `# file: ${filePath} | ${kindLabel}`;
}
