import { describe, expect, it } from "bun:test";

import { matchTolerantAnchor } from "./tolerant-anchor-match";

describe("matchTolerantAnchor", () => {
  it("never overshoots the blank-line boundary into a following table (DRIVING regression)", () => {
    // Historical false-green: a naive absorb-until-last-line matcher that
    // ignores blank-line boundaries risks walking past the blank into
    // [lints.rust] while hunting for the last anchor line. The hardened
    // matcher here has a REAL, unambiguous match ending exactly at
    // `must_use_candidate` (the last non-blank line before the boundary);
    // the machine-checkable regression proof is that the returned region
    // never crosses the blank line, so [lints.rust] survives byte-for-byte
    // untouched regardless of what the caller splices in.
    const content = [
      "[lints.clippy]",
      "# Enforce stricter linting for better code quality",
      'pedantic = { level = "warn", priority = -1 }',
      "# Allow some pedantic lints that are too strict for this project",
      'module_name_repetitions = "allow"',
      'must_use_candidate = "allow"',
      "",
      "[lints.rust]",
      'unsafe_code = "forbid"',
    ].join("\n");

    const search = [
      "[lints.clippy]",
      'pedantic = { level = "warn", priority = -1 }',
      'module_name_repetitions = "allow"',
      'must_use_candidate = "allow"',
    ].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const blankLineOffset = content.indexOf("\n\n") + 1;
      // The matched region must end at or before the blank line -- it never
      // crosses into [lints.rust].
      expect(result.value.endOffset).toBeLessThanOrEqual(blankLineOffset);
      // Everything from the blank line onward (including [lints.rust]) is
      // outside the matched region and therefore untouched by any splice.
      expect(content.slice(result.value.endOffset)).toBe(
        content.slice(content.indexOf("\n\n[lints.rust]")),
      );
    }
  });

  it("rejects (fails closed) when the anchor's true endpoint is ambiguous across a would-be overshoot", () => {
    // A pathological paraphrase whose last anchor line ALSO recurs after the
    // dropped-comment run -- e.g. a duplicated key -- must not let the
    // matcher silently pick either occurrence.
    const content = ["[table]", "# comment", 'flag = "allow"', "# comment2", 'flag = "allow"'].join(
      "\n",
    );
    const search = ["[table]", 'flag = "allow"'].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["ambiguous", "not-found"]).toContain(result.error.reason);
    }
  });

  it("captures the exact on-disk bytes including dropped comment lines (happy path)", () => {
    const content = [
      "[lints.clippy]",
      "# Enforce stricter linting for better code quality",
      'pedantic = { level = "warn", priority = -1 }',
      "# Allow some pedantic lints that are too strict for this project",
      'module_name_repetitions = "allow"',
      'must_use_candidate = "allow"',
    ].join("\n");

    const search = [
      "[lints.clippy]",
      'pedantic = { level = "warn", priority = -1 }',
      'module_name_repetitions = "allow"',
      'must_use_candidate = "allow"',
    ].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(content.slice(result.value.startOffset, result.value.endOffset)).toBe(content);
      expect(content.slice(0, result.value.startOffset)).toBe("");
      expect(content.slice(result.value.endOffset)).toBe("");
    }
  });

  it("returns not-found when the first anchor line appears nowhere", () => {
    const content = ["[lints.clippy]", 'pedantic = "warn"'].join("\n");
    const search = ["[completely.absent]", 'foo = "bar"'].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("not-found");
    }
  });

  it("returns ambiguous when two disjoint blank-separated regions each satisfy the search", () => {
    const search = ["[table]", 'key = "value"'].join("\n");
    const content = [
      "[table]",
      "# comment",
      'key = "value"',
      "",
      "[table]",
      "# another comment",
      'key = "value"',
    ].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("ambiguous");
    }
  });

  it("returns ambiguous when the last anchor line recurs within one contiguous non-blank run", () => {
    const search = ["[table]", 'key = "value"'].join("\n");
    const content = ["[table]", "# comment", 'key = "value"', "# comment2", 'key = "value"'].join(
      "\n",
    );

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("ambiguous");
    }
  });

  it("absorbs a single dropped extra line within a contiguous non-blank run", () => {
    const content = ["[table]", "# extra comment", 'key = "value"'].join("\n");
    const search = ["[table]", 'key = "value"'].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(content.slice(result.value.startOffset, result.value.endOffset)).toBe(content);
    }
  });

  it("absorbs a Rust `//` comment line (proving no # hardcoding)", () => {
    const content = ["[table]", "// rust style comment", 'key = "value"'].join("\n");
    const search = ["[table]", 'key = "value"'].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(content.slice(result.value.startOffset, result.value.endOffset)).toBe(content);
    }
  });

  it("absorbs Haskell `--` and `{- -}` comment lines (proving no comment-token hardcoding)", () => {
    const content = [
      "[table]",
      "-- haskell line comment",
      "{- block comment -}",
      'key = "value"',
    ].join("\n");
    const search = ["[table]", 'key = "value"'].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(content.slice(result.value.startOffset, result.value.endOffset)).toBe(content);
    }
  });

  it("fails closed when a matched line's leading indentation differs", () => {
    const content = ["[table]", '    key = "value"'].join("\n");
    const search = ["[table]", 'key = "value"'].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("not-found");
    }
  });

  it("collapses internal whitespace drift while keeping indentation strict", () => {
    const content = ["[table]", 'pedantic  =  { level = "warn" }'].join("\n");
    const search = ["[table]", 'pedantic = { level = "warn" }'].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(content.slice(result.value.startOffset, result.value.endOffset)).toBe(content);
    }

    // Paired assertion: an indentation-only difference still fails.
    const indentedContent = ["[table]", '  pedantic = { level = "warn" }'].join("\n");
    const indentedResult = matchTolerantAnchor(indentedContent, search);
    expect(indentedResult.ok).toBe(false);
    if (!indentedResult.ok) {
      expect(indentedResult.error.reason).toBe("not-found");
    }
  });

  it("matches a single-line search anchor directly", () => {
    const content = ["[table]", 'key = "value"'].join("\n");
    const search = "[table]";

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(content.slice(result.value.startOffset, result.value.endOffset)).toBe("[table]");
    }
  });

  it("returns not-found when a blank line interrupts the walk before the penultimate anchor is matched", () => {
    const content = ["[table]", "", 'key = "value"'].join("\n");
    const search = ["[table]", "middle", 'key = "value"'].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("not-found");
    }
  });

  it("returns not-found when content ends before the penultimate anchor is matched", () => {
    const content = ["[table]", "# only comment"].join("\n");
    const search = ["[table]", "middle", 'key = "value"'].join("\n");

    const result = matchTolerantAnchor(content, search);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("not-found");
    }
  });
});
