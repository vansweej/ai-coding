import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { PipelineContext, StepResult } from "../pipeline-types";
import { createFileWriterStep } from "./file-writer-step";

/** Build a minimal PipelineContext with a single prior step result. */
function makeCtx(stepName: string, output: string): PipelineContext<unknown> {
  const result: StepResult = { stepName, output, durationMs: 0 };
  const results = new Map<string, StepResult>([[stepName, result]]);
  return { event: {}, results };
}

let baseDir: string;

beforeEach(() => {
  baseDir = join(tmpdir(), `file-writer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(baseDir, { recursive: true });
});

afterEach(() => {
  // Temp dirs are cleaned up by the OS; no explicit teardown needed.
});

describe("createFileWriterStep", () => {
  it("writes a single file from a prior step's output", async () => {
    const step = createFileWriterStep("write", { readFrom: "implement", baseDir });
    const ctx = makeCtx("implement", "```rust src/lib.rs\nfn foo() {}\n```");
    const result = await step.execute(ctx);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(baseDir, "src/lib.rs"), "utf8")).toBe("fn foo() {}");
  });

  it("writes multiple files and creates intermediate directories", async () => {
    const step = createFileWriterStep("write", { readFrom: "implement", baseDir });
    const ctx = makeCtx(
      "implement",
      [
        "```rust src/main.rs",
        "fn main() {}",
        "```",
        "",
        "```toml Cargo.toml",
        "[package]",
        "```",
      ].join("\n"),
    );
    const result = await step.execute(ctx);
    expect(result.ok).toBe(true);
    expect(existsSync(join(baseDir, "src/main.rs"))).toBe(true);
    expect(existsSync(join(baseDir, "Cargo.toml"))).toBe(true);
  });

  it("returns a summary listing written file paths", async () => {
    const step = createFileWriterStep("write", { readFrom: "implement", baseDir });
    const ctx = makeCtx("implement", "```rust src/lib.rs\nfn foo() {}\n```");
    const result = await step.execute(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe("Wrote 1 file: src/lib.rs");
    }
  });

  it("fails when the readFrom step is not in context", async () => {
    const step = createFileWriterStep("write", { readFrom: "missing", baseDir });
    const ctx: PipelineContext<unknown> = { event: {}, results: new Map() };
    const result = await step.execute(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain('"missing"');
    }
  });

  it("fails when no fenced blocks with file paths are found", async () => {
    const step = createFileWriterStep("write", { readFrom: "implement", baseDir });
    const ctx = makeCtx("implement", "```rust\nfn main() {}\n```");
    const result = await step.execute(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("no fenced code blocks");
    }
  });

  it("rejects an absolute file path", async () => {
    const step = createFileWriterStep("write", { readFrom: "implement", baseDir });
    const ctx = makeCtx("implement", "```rust /etc/passwd\nevil content\n```");
    const result = await step.execute(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("must be relative");
    }
  });

  it("rejects a path traversal attempt", async () => {
    const step = createFileWriterStep("write", { readFrom: "implement", baseDir });
    const ctx = makeCtx("implement", "```rust ../../etc/passwd\nevil content\n```");
    const result = await step.execute(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("escapes the base directory");
    }
  });

  it("overwrites an existing file by default", async () => {
    const filePath = join(baseDir, "src/lib.rs");
    mkdirSync(join(baseDir, "src"), { recursive: true });
    writeFileSync(filePath, "old content", "utf8");
    const step = createFileWriterStep("write", { readFrom: "implement", baseDir });
    const ctx = makeCtx("implement", "```rust src/lib.rs\nnew content\n```");
    await step.execute(ctx);
    expect(readFileSync(filePath, "utf8")).toBe("new content");
  });

  it("skips existing files when overwrite is false", async () => {
    const filePath = join(baseDir, "src/lib.rs");
    mkdirSync(join(baseDir, "src"), { recursive: true });
    writeFileSync(filePath, "original content", "utf8");
    const step = createFileWriterStep("write", {
      readFrom: "implement",
      baseDir,
      overwrite: false,
    });
    const ctx = makeCtx("implement", "```rust src/lib.rs\nnew content\n```");
    const result = await step.execute(ctx);
    expect(result.ok).toBe(true);
    expect(readFileSync(filePath, "utf8")).toBe("original content");
    if (result.ok) {
      expect(result.value.output).toContain("No files written");
    }
  });

  it("writes a new file when overwrite is false and the file does not yet exist", async () => {
    const step = createFileWriterStep("write", { readFrom: "implement", baseDir, overwrite: false });
    const ctx = makeCtx("implement", "```rust src/new.rs\nfn new() {}\n```");
    const result = await step.execute(ctx);
    expect(result.ok).toBe(true);
    expect(existsSync(join(baseDir, "src/new.rs"))).toBe(true);
  });

  it("uses plural 'files' in the summary when writing more than one file", async () => {
    const step = createFileWriterStep("write", { readFrom: "implement", baseDir });
    const ctx = makeCtx(
      "implement",
      ["```rust src/a.rs", "fn a() {}", "```", "```rust src/b.rs", "fn b() {}", "```"].join("\n"),
    );
    const result = await step.execute(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe("Wrote 2 files: src/a.rs, src/b.rs");
    }
  });
});
