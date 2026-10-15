import { describe, expect, it } from "bun:test";
import { checkEditScope, isEditScopeGuardEnabled, isProseFile } from "./edit-scope-guard";

describe("isEditScopeGuardEnabled", () => {
  it("is enabled when unset", () => {
    expect(isEditScopeGuardEnabled({})).toBe(true);
  });

  it("is disabled for exactly `off`", () => {
    expect(isEditScopeGuardEnabled({ AI_CODING_EDIT_SCOPE_GUARD: "off" })).toBe(false);
  });

  it("is disabled for ` OFF ` (trimmed and lowercased)", () => {
    expect(isEditScopeGuardEnabled({ AI_CODING_EDIT_SCOPE_GUARD: " OFF " })).toBe(false);
  });

  it("is enabled for `on`", () => {
    expect(isEditScopeGuardEnabled({ AI_CODING_EDIT_SCOPE_GUARD: "on" })).toBe(true);
  });

  it("is enabled for `0` (only `off` disables)", () => {
    expect(isEditScopeGuardEnabled({ AI_CODING_EDIT_SCOPE_GUARD: "0" })).toBe(true);
  });
});

describe("isProseFile", () => {
  it("treats .md/.mdx/.markdown/.txt as prose", () => {
    expect(isProseFile("docs/x.md")).toBe(true);
    expect(isProseFile("a.MDX")).toBe(true);
    expect(isProseFile("NOTES.markdown")).toBe(true);
    expect(isProseFile("log.txt")).toBe(true);
  });

  it("treats code files and extensionless paths as non-prose", () => {
    expect(isProseFile("src/a.ts")).toBe(false);
    expect(isProseFile("src/lib.rs")).toBe(false);
    expect(isProseFile("Makefile")).toBe(false);
  });
});

describe("checkEditScope R1 elision placeholder", () => {
  it("flags a bare `// existing code` placeholder introduced in REPLACE", () => {
    const result = checkEditScope(
      "const a = 1;\nconst b = 2;",
      "const a = 1;\n// existing code",
      "src/a.ts",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("elision-placeholder");
  });

  it("flags an ellipsis-bounded `// ... existing code ...` placeholder", () => {
    const result = checkEditScope(
      "line one\nline two",
      "line one\n// ... existing code ...",
      "src/a.ts",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("elision-placeholder");
  });

  it("flags an ellipsis-only comment placeholder", () => {
    const result = checkEditScope("line one\nline two", "line one\n// ...", "src/a.ts");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("elision-placeholder");
  });

  it("flags a `# rest of the file unchanged` placeholder", () => {
    const result = checkEditScope(
      "a = 1\nb = 2",
      "a = 1\n# rest of the file unchanged",
      "src/a.py",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("elision-placeholder");
  });

  it("flags a `/// existing code` doc-comment placeholder in a .rs file", () => {
    const result = checkEditScope(
      "let a = 1;\nlet b = 2;",
      "let a = 1;\n/// existing code",
      "src/lib.rs",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("elision-placeholder");
  });

  it("flags a `//! rest of the file unchanged` inner-doc placeholder in a .rs file", () => {
    const result = checkEditScope(
      "let a = 1;\nlet b = 2;",
      "let a = 1;\n//! rest of the file unchanged",
      "src/lib.rs",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("elision-placeholder");
  });

  it("flags an ellipsis-only HTML comment placeholder", () => {
    const result = checkEditScope(
      "<p>one</p>\n<p>two</p>",
      "<p>one</p>\n<!-- ... -->",
      "src/a.html",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("elision-placeholder");
  });

  it("does NOT flag `// refactor existing code paths` (prose mention)", () => {
    expect(
      checkEditScope("const a = 1;", "const a = 1;\n// refactor existing code paths", "src/a.ts")
        .ok,
    ).toBe(true);
  });

  it("does NOT flag `// behaviour is unchanged when x is null` (prose mention)", () => {
    expect(
      checkEditScope(
        "const a = 1;",
        "const a = 1;\n// behaviour is unchanged when x is null",
        "src/a.ts",
      ).ok,
    ).toBe(true);
  });

  it("allows a comment that merely contains the word placeholder", () => {
    expect(
      checkEditScope("// old note", "// placeholder text shown in the empty input", "src/a.ts").ok,
    ).toBe(true);
  });

  it("allows a legit doc rewrite with new non-placeholder prose", () => {
    expect(
      checkEditScope(
        "// old description of the function",
        "// computes the running total of all line items",
        "src/a.ts",
      ).ok,
    ).toBe(true);
  });

  it("allows deleting an ASCII comment line", () => {
    expect(checkEditScope("// a comment\nconst x = 1;", "const x = 1;", "src/a.ts").ok).toBe(true);
  });

  it("does not treat a C/Rust deref line as a comment", () => {
    expect(checkEditScope("*ptr = 5;", "*ptr = 6;", "src/a.rs").ok).toBe(true);
  });

  it("does not treat a Rust attribute as a comment", () => {
    expect(
      checkEditScope(
        "#[derive(Debug)]\nstruct S;",
        "#[derive(Debug, Clone)]\nstruct S;",
        "src/a.rs",
      ).ok,
    ).toBe(true);
  });

  it("allows REPLACE introducing SQL/Haskell `---` and `--i;` lines", () => {
    const result = checkEditScope("x = 1\ny = 2", "x = 1\n---\n--i;", "src/a.hs");
    expect(result.ok).toBe(true);
  });

  it("flags the same R1 placeholder in a .ts file but allows a `## Unchanged` heading in a .md file", () => {
    expect(checkEditScope("a\nb", "a\n// existing code", "src/a.ts").ok).toBe(false);
    expect(checkEditScope("## one\n## two", "## one\n## Unchanged", "docs/x.md").ok).toBe(true);
  });
});

describe("checkEditScope R2 non-ASCII substitution", () => {
  it("flags dropping a non-ASCII doc comment replaced by a same-token comment (the live incident)", () => {
    const search = "/// Type scheme for polymorphic types: \u2200\u03b1.\u03c4\npub struct Scheme;";
    const replace = "/// placeholder_marker_removed\npub struct Scheme;";
    const result = checkEditScope(search, replace, "src/scheme.rs");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("non-ascii-destruction");
    expect(result.error.offendingLine).toContain("\u2200");
  });

  it("flags a `///` doc comment substituted by a `//` line comment (same // family)", () => {
    const search = "/// doc \u2200\u03b1.\u03c4\npub struct S;";
    const replace = "// placeholder\npub struct S;";
    const result = checkEditScope(search, replace, "src/a.rs");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("non-ascii-destruction");
  });

  it("allows deleting a non-ASCII comment line outright", () => {
    const search = "// note \u2014 detail\nconst x = 1;";
    const replace = "const x = 1;";
    expect(checkEditScope(search, replace, "src/a.ts").ok).toBe(true);
  });

  it("allows rewriting a non-ASCII string-literal code line", () => {
    expect(checkEditScope('const s = "caf\u00e9";', 'const s = "cafe";', "src/a.ts").ok).toBe(true);
  });

  it("allows rewriting a non-ASCII comment into a DIFFERENT-family ASCII comment", () => {
    expect(checkEditScope("# a \u2014 b", "// a b", "src/a.ts").ok).toBe(true);
  });

  it("allows keeping a non-ASCII line verbatim", () => {
    const search = "/// \u2200\u03b1.\u03c4 scheme\npub struct S;";
    const replace = "/// \u2200\u03b1.\u03c4 scheme\npub struct T;";
    expect(checkEditScope(search, replace, "src/a.rs").ok).toBe(true);
  });

  it("allows moving a non-ASCII line to a different position", () => {
    const search = "pub struct S;\n/// \u2200\u03b1.\u03c4 scheme";
    const replace = "/// \u2200\u03b1.\u03c4 scheme\npub struct S;";
    expect(checkEditScope(search, replace, "src/a.rs").ok).toBe(true);
  });
});

describe("checkEditScope R3 truncation-marker echo", () => {
  it("flags a REPLACE that echoes the truncation marker absent from SEARCH", () => {
    const result = checkEditScope(
      "const header = 1;\nconst tail = 2;",
      "const header = 1;\n[ai-coding: truncated 1200 chars]",
      "src/a.ts",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("truncation-marker-echo");
  });

  it("flags a truncation-marker echo even in a prose file", () => {
    const result = checkEditScope(
      "header\ntail",
      "header\n[ai-coding: truncated 10 chars]",
      "docs/x.md",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected violation");
    expect(result.error.rule).toBe("truncation-marker-echo");
  });

  it("allows a REPLACE marker when SEARCH already contains it", () => {
    const search = "line\n[ai-coding: truncated 10 chars]";
    const replace = "line changed\n[ai-coding: truncated 10 chars]";
    expect(checkEditScope(search, replace, "src/a.ts").ok).toBe(true);
  });
});
