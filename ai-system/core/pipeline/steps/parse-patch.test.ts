import { describe, expect, it } from "bun:test";
import { parsePatch, stripEnclosingFence } from "./parse-patch";

describe("parsePatch", () => {
  it("parses a single well-formed edit", () => {
    const raw = `src/main.ts
<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    const edit = result.value[0];
    expect(edit?.filePath).toBe("src/main.ts");
    expect(edit?.search).toBe("const x = 1;");
    expect(edit?.replace).toBe("const x = 2;");
    expect(edit?.isCreate).toBe(false);
  });

  it("parses multiple edits in one payload", () => {
    const raw = `src/a.ts
<<<<<<< SEARCH
old a
=======
new a
>>>>>>> REPLACE

src/b.ts
<<<<<<< SEARCH
old b
=======
new b
>>>>>>> REPLACE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.filePath).toBe("src/a.ts");
    expect(result.value[0]?.search).toBe("old a");
    expect(result.value[0]?.replace).toBe("new a");
    expect(result.value[1]?.filePath).toBe("src/b.ts");
    expect(result.value[1]?.search).toBe("old b");
    expect(result.value[1]?.replace).toBe("new b");
  });

  it("sets isCreate=true when SEARCH body is empty", () => {
    const raw = `src/new-file.ts
<<<<<<< SEARCH
=======
const newCode = "hello";
>>>>>>> REPLACE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    const edit = result.value[0];
    expect(edit?.filePath).toBe("src/new-file.ts");
    expect(edit?.search).toBe("");
    expect(edit?.replace).toBe('const newCode = "hello";');
    expect(edit?.isCreate).toBe(true);
  });

  it("returns PatchParseError on unterminated SEARCH block", () => {
    const raw = `src/broken.ts
<<<<<<< SEARCH
some content
no separator here`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.message).toContain("unterminated SEARCH block");
    expect(result.error.message).toContain("src/broken.ts");
  });

  it("returns PatchParseError on missing file-path header", () => {
    const raw = `<<<<<<< SEARCH
some content
=======
replacement
>>>>>>> REPLACE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.message).toContain("Unexpected marker line without file-path header");
  });

  it("allows replacement text containing lines that look like markers", () => {
    const raw = `src/config.ts
<<<<<<< SEARCH
old config
=======
# This is a comment with <<<<<<< SEARCH in it
# And another line with >>>>>>> REPLACE
const config = { value: "test" };
>>>>>>> REPLACE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    const edit = result.value[0];
    expect(edit?.replace).toContain("<<<<<<< SEARCH");
    expect(edit?.replace).toContain(">>>>>>> REPLACE");
  });

  it("handles multi-line SEARCH and REPLACE bodies", () => {
    const raw = `src/complex.ts
<<<<<<< SEARCH
function oldFunc() {
  return 1;
}
=======
function newFunc() {
  return 2;
}
>>>>>>> REPLACE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    const edit = result.value[0];
    expect(edit?.search).toContain("function oldFunc()");
    expect(edit?.search).toContain("return 1;");
    expect(edit?.replace).toContain("function newFunc()");
    expect(edit?.replace).toContain("return 2;");
  });

  it("returns PatchParseError on unterminated REPLACE block", () => {
    const raw = `src/broken.ts
<<<<<<< SEARCH
anchor
=======
replacement
no end marker`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.message).toContain("unterminated REPLACE block");
  });

  it("handles empty lines between edits", () => {
    const raw = `src/a.ts
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE


src/b.ts
<<<<<<< SEARCH
old2
=======
new2
>>>>>>> REPLACE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(2);
  });

  it("parses a MOVE block for a file", () => {
    const raw = `src/old-name.ts
<<<<<<< MOVE
=======
src/new-name.ts
>>>>>>> MOVE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    const edit = result.value[0];
    expect(edit?.filePath).toBe("src/old-name.ts");
    expect(edit?.toPath).toBe("src/new-name.ts");
    expect(edit?.isMove).toBe(true);
    expect(edit?.isCreate).toBe(false);
  });

  it("parses a MOVE block for a directory", () => {
    const raw = `src
<<<<<<< MOVE
=======
crates/parlang/src
>>>>>>> MOVE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(1);
    const edit = result.value[0];
    expect(edit?.filePath).toBe("src");
    expect(edit?.toPath).toBe("crates/parlang/src");
    expect(edit?.isMove).toBe(true);
  });

  it("parses MOVE mixed with SEARCH/REPLACE and create blocks in one payload", () => {
    const raw = `src/old.ts
<<<<<<< MOVE
=======
src/new.ts
>>>>>>> MOVE

src/edit.ts
<<<<<<< SEARCH
old
=======
new
>>>>>>> REPLACE

src/created.ts
<<<<<<< SEARCH
=======
fresh content
>>>>>>> REPLACE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");

    expect(result.value).toHaveLength(3);
    expect(result.value[0]?.isMove).toBe(true);
    expect(result.value[0]?.filePath).toBe("src/old.ts");
    expect(result.value[0]?.toPath).toBe("src/new.ts");
    expect(result.value[1]?.isMove).toBe(false);
    expect(result.value[1]?.filePath).toBe("src/edit.ts");
    expect(result.value[2]?.isCreate).toBe(true);
    expect(result.value[2]?.filePath).toBe("src/created.ts");
  });

  it("returns PatchParseError on unterminated MOVE block (missing separator)", () => {
    const raw = `src/old.ts
<<<<<<< MOVE
src/new.ts
no separator here`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.message).toContain("unterminated MOVE block");
    expect(result.error.message).toContain(`"=======" separator`);
  });

  it("returns PatchParseError on unterminated MOVE block (missing terminator)", () => {
    const raw = `src/old.ts
<<<<<<< MOVE
=======
src/new.ts
no end marker`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.message).toContain("unterminated MOVE block");
    expect(result.error.message).toContain(`">>>>>>> MOVE" marker`);
  });

  it("returns PatchParseError on empty MOVE destination path", () => {
    const raw = `src/old.ts
<<<<<<< MOVE
=======
>>>>>>> MOVE`;

    const result = parsePatch(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error result");

    expect(result.error.message).toContain("empty MOVE destination path");
  });
});

describe("stripEnclosingFence", () => {
  it("strips a fence with a language tag", () => {
    const raw = `\`\`\`bash
src/main.ts
<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE
\`\`\``;

    const stripped = stripEnclosingFence(raw);
    const result = parsePatch(stripped);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.filePath).toBe("src/main.ts");
  });

  it("strips a fence with no language tag", () => {
    const raw = `\`\`\`
src/main.ts
<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE
\`\`\``;

    const stripped = stripEnclosingFence(raw);
    expect(stripped).not.toContain("```");
  });

  it("returns unfenced input unchanged", () => {
    const raw = `src/main.ts
<<<<<<< SEARCH
const x = 1;
=======
const x = 2;
>>>>>>> REPLACE`;

    expect(stripEnclosingFence(raw)).toBe(raw);
  });

  it("does not corrupt an inner fence that is part of the REPLACE body", () => {
    const raw = `src/docs.md
<<<<<<< SEARCH
old docs
=======
Example:
\`\`\`ts
const x = 1;
\`\`\`
>>>>>>> REPLACE`;

    // Not enclosed by an outer fence, so this must be returned unchanged --
    // the inner ```ts / ``` pair must survive intact.
    const stripped = stripEnclosingFence(raw);
    expect(stripped).toBe(raw);
    expect(stripped).toContain("```ts");
  });

  it("allows a fenced MOVE payload to parse after stripping", () => {
    const raw = `\`\`\`bash
src/old.ts
<<<<<<< MOVE
=======
src/new.ts
>>>>>>> MOVE
\`\`\``;

    const result = parsePatch(stripEnclosingFence(raw));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok result");
    expect(result.value[0]?.isMove).toBe(true);
    expect(result.value[0]?.toPath).toBe("src/new.ts");
  });
});
