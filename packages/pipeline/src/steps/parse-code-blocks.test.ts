import { describe, expect, it } from "bun:test";

import { parseCodeBlocks } from "./parse-code-blocks";

describe("parseCodeBlocks", () => {
  it("returns empty array for empty input", () => {
    expect(parseCodeBlocks("")).toEqual([]);
  });

  it("returns empty array when no code blocks present", () => {
    expect(parseCodeBlocks("Just some prose text.\nNo code blocks here.")).toEqual([]);
  });

  it("parses a single block with language and file path", () => {
    const text = "```rust src/lib.rs\nfn main() {}\n```";
    const result = parseCodeBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      language: "rust",
      filePath: "src/lib.rs",
      content: "fn main() {}",
    });
  });

  it("parses a block with file path but no language", () => {
    const text = "``` flake.nix\n{ inputs = {}; }\n```";
    const result = parseCodeBlocks(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ language: "", filePath: "flake.nix", content: "{ inputs = {}; }" });
  });

  it("skips a block with only a language and no file path", () => {
    const text = "```rust\nfn main() {}\n```";
    expect(parseCodeBlocks(text)).toHaveLength(0);
  });

  it("skips a block with an empty info string", () => {
    const text = "```\nsome content\n```";
    expect(parseCodeBlocks(text)).toHaveLength(0);
  });

  it("parses multiple blocks independently", () => {
    const text = [
      "```rust src/main.rs",
      "fn main() {}",
      "```",
      "",
      "```toml Cargo.toml",
      "[package]",
      'name = "hello"',
      "```",
    ].join("\n");
    const result = parseCodeBlocks(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ language: "rust", filePath: "src/main.rs" });
    expect(result[1]).toMatchObject({ language: "toml", filePath: "Cargo.toml" });
  });

  it("preserves content indentation", () => {
    const text = "```typescript src/index.ts\nexport function foo() {\n  return 42;\n}\n```";
    const result = parseCodeBlocks(text);
    expect(result[0]?.content).toBe("export function foo() {\n  return 42;\n}");
  });

  it("trims trailing whitespace from the info string file path", () => {
    const text = "```rust src/lib.rs   \nfn foo() {}\n```";
    const result = parseCodeBlocks(text);
    expect(result[0]?.filePath).toBe("src/lib.rs");
  });

  it("handles file path with subdirectory components", () => {
    const text = "```cpp src/core/engine/renderer.cpp\nvoid render() {}\n```";
    const result = parseCodeBlocks(text);
    expect(result[0]?.filePath).toBe("src/core/engine/renderer.cpp");
  });

  it("captures multi-line content correctly", () => {
    const text = "```python scripts/run.py\nimport os\n\ndef main():\n    pass\n```";
    const result = parseCodeBlocks(text);
    expect(result[0]?.content).toBe("import os\n\ndef main():\n    pass");
  });

  it("skips a block without file path even when surrounded by valid blocks", () => {
    const text = [
      "```rust src/lib.rs",
      "fn lib() {}",
      "```",
      "```rust",
      "fn skipped() {}",
      "```",
      "```toml Cargo.toml",
      "[package]",
      "```",
    ].join("\n");
    const result = parseCodeBlocks(text);
    expect(result).toHaveLength(2);
    expect(result[0]?.filePath).toBe("src/lib.rs");
    expect(result[1]?.filePath).toBe("Cargo.toml");
  });
});
