import { describe, it, expect } from "bun:test";
import { isAutoExempt, resolveCoverageThreshold } from "./coverage-exemption";
import type { CoverageDirective } from "../plan-parser";

describe("isAutoExempt", () => {
  it("returns true for pure-comment diff", () => {
    const diff = `diff --git a/src/main.rs b/src/main.rs
index 1234567..abcdefg 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
+    // This is a comment
     println!("hello");
 }`;

    expect(isAutoExempt(diff)).toBe(true);
  });

  it("returns true for test-file-only diff", () => {
    const diff = `diff --git a/src/main.test.ts b/src/main.test.ts
index 1234567..abcdefg 100644
--- a/src/main.test.ts
+++ b/src/main.test.ts
@@ -1,3 +1,5 @@
 describe("main", () => {
+  it("should work", () => {
+    expect(true).toBe(true);
+  });
 });`;

    expect(isAutoExempt(diff)).toBe(true);
  });

  it("returns true for empty lines only", () => {
    const diff = `diff --git a/src/main.rs b/src/main.rs
index 1234567..abcdefg 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,5 @@
 fn main() {
+
+
     println!("hello");
 }`;

    expect(isAutoExempt(diff)).toBe(true);
  });

  it("returns false when one real line is added", () => {
    const diff = `diff --git a/src/main.rs b/src/main.rs
index 1234567..abcdefg 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
+    let x = 42;
     println!("hello");
 }`;

    expect(isAutoExempt(diff)).toBe(false);
  });

  it("returns false when multiple real lines are added", () => {
    const diff = `diff --git a/src/main.rs b/src/main.rs
index 1234567..abcdefg 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,5 @@
 fn main() {
+    let x = 42;
+    let y = 100;
     println!("hello");
 }`;

    expect(isAutoExempt(diff)).toBe(false);
  });

  it("ignores hash-style comments", () => {
    const diff = `diff --git a/script.py b/script.py
index 1234567..abcdefg 100644
--- a/script.py
+++ b/script.py
@@ -1,3 +1,4 @@
 def main():
+    # This is a comment
     print("hello")`;

    expect(isAutoExempt(diff)).toBe(true);
  });

  it("handles multiple files with mixed changes", () => {
    const diff = `diff --git a/src/main.rs b/src/main.rs
index 1234567..abcdefg 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,4 @@
 fn main() {
+    // comment
     println!("hello");
 }
diff --git a/src/main.test.rs b/src/main.test.rs
index 2345678..bcdefgh 100644
--- a/src/main.test.rs
+++ b/src/main.test.rs
@@ -1,3 +1,5 @@
 #[test]
 fn test_main() {
+    let x = 42;
+    assert_eq!(x, 42);
 }`;

    expect(isAutoExempt(diff)).toBe(true);
  });

  it("returns false when real code is added alongside comments", () => {
    const diff = `diff --git a/src/main.rs b/src/main.rs
index 1234567..abcdefg 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,3 +1,5 @@
 fn main() {
+    // TODO: implement this
+    let x = 42;
     println!("hello");
 }`;

    expect(isAutoExempt(diff)).toBe(false);
  });

  it("handles underscore-style test files", () => {
    const diff = `diff --git a/src/main_test.ts b/src/main_test.ts
index 1234567..abcdefg 100644
--- a/src/main_test.ts
+++ b/src/main_test.ts
@@ -1,3 +1,5 @@
 describe("main", () => {
+  it("should work", () => {
+    expect(true).toBe(true);
+  });
 });`;

    expect(isAutoExempt(diff)).toBe(true);
  });
});

describe("resolveCoverageThreshold", () => {
  it("returns gated: false when directive is skip", () => {
    const directive: CoverageDirective = { mode: "skip" };
    const diff = `diff --git a/src/main.rs b/src/main.rs
+let x = 42;`;

    const result = resolveCoverageThreshold(directive, diff);
    expect(result.gated).toBe(false);
    expect(result.percent).toBe(0);
  });

  it("returns gated: false when auto-exempt applies", () => {
    const directive: CoverageDirective = { mode: "default" };
    const diff = `diff --git a/src/main.rs b/src/main.rs
+    // comment`;

    const result = resolveCoverageThreshold(directive, diff);
    expect(result.gated).toBe(false);
    expect(result.percent).toBe(0);
  });

  it("returns explicit threshold when directive specifies it", () => {
    const directive: CoverageDirective = { mode: "threshold", percent: 95 };
    const diff = `diff --git a/src/main.rs b/src/main.rs
+let x = 42;`;

    const result = resolveCoverageThreshold(directive, diff);
    expect(result.gated).toBe(true);
    expect(result.percent).toBe(95);
  });

  it("returns default 90% when directive is default and not auto-exempt", () => {
    const directive: CoverageDirective = { mode: "default" };
    const diff = `diff --git a/src/main.rs b/src/main.rs
+let x = 42;`;

    const result = resolveCoverageThreshold(directive, diff);
    expect(result.gated).toBe(true);
    expect(result.percent).toBe(90);
  });

  it("auto-exempt takes precedence over lower explicit threshold", () => {
    const directive: CoverageDirective = { mode: "threshold", percent: 85 };
    const diff = `diff --git a/src/main.rs b/src/main.rs
+    // comment`;

    const result = resolveCoverageThreshold(directive, diff);
    // Explicit threshold overrides auto-exempt (any explicit threshold is stricter than no gate)
    expect(result.gated).toBe(true);
    expect(result.percent).toBe(85);
  });

  it("honors explicit threshold when it raises strictness above auto-exempt", () => {
    const directive: CoverageDirective = { mode: "threshold", percent: 95 };
    const diff = `diff --git a/src/main.rs b/src/main.rs
+    // comment`;

    const result = resolveCoverageThreshold(directive, diff);
    // Explicit 95% overrides auto-exempt
    expect(result.gated).toBe(true);
    expect(result.percent).toBe(95);
  });

  it("respects skip directive even with real code changes", () => {
    const directive: CoverageDirective = { mode: "skip" };
    const diff = `diff --git a/src/main.rs b/src/main.rs
+let x = 42;
+let y = 100;
+let z = 200;`;

    const result = resolveCoverageThreshold(directive, diff);
    expect(result.gated).toBe(false);
    expect(result.percent).toBe(0);
  });

  it("returns 100% threshold when specified", () => {
    const directive: CoverageDirective = { mode: "threshold", percent: 100 };
    const diff = `diff --git a/src/main.rs b/src/main.rs
+let x = 42;`;

    const result = resolveCoverageThreshold(directive, diff);
    expect(result.gated).toBe(true);
    expect(result.percent).toBe(100);
  });

  it("returns 0% threshold when specified", () => {
    const directive: CoverageDirective = { mode: "threshold", percent: 0 };
    const diff = `diff --git a/src/main.rs b/src/main.rs
+let x = 42;`;

    const result = resolveCoverageThreshold(directive, diff);
    expect(result.gated).toBe(true);
    expect(result.percent).toBe(0);
  });

  it("handles empty diff with default directive", () => {
    const directive: CoverageDirective = { mode: "default" };
    const diff = "";

    const result = resolveCoverageThreshold(directive, diff);
    expect(result.gated).toBe(false);
    expect(result.percent).toBe(0);
  });

  it("handles empty diff with explicit threshold", () => {
    const directive: CoverageDirective = { mode: "threshold", percent: 80 };
    const diff = "";

    const result = resolveCoverageThreshold(directive, diff);
    // Empty diff is auto-exempt, but explicit threshold overrides it
    expect(result.gated).toBe(true);
    expect(result.percent).toBe(80);
  });
});
