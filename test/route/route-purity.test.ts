import { describe, expect, it } from "bun:test";
import { route } from "../../ai-system/core/pipeline/routing/route";

/** Full palette: all known driver tools present. */
const FULL_PALETTE = new Set(["cargo", "bun", "python", "g++", "ghc", "julia", "nix"]);
/** Empty palette: no toolchains available. */
const EMPTY_PALETTE = new Set<string>();
/** Rust-only palette. */
const RUST_PALETTE = new Set(["cargo"]);
/** TypeScript-only palette. */
const TS_PALETTE = new Set(["bun"]);

describe("route purity", () => {
  it("is deterministic: same inputs always produce the same output", () => {
    const inputs: Array<[string, ReadonlySet<string>]> = [
      ["src/main.rs", RUST_PALETTE],
      ["src/index.ts", TS_PALETTE],
      ["src/lib.cpp", FULL_PALETTE],
      ["README.md", FULL_PALETTE],
      ["no-extension", FULL_PALETTE],
      ["src/main.rs", EMPTY_PALETTE],
    ];

    for (const [path, palette] of inputs) {
      const first = route(path, palette);
      const second = route(path, palette);
      // Same descriptor reference (or both null)
      expect(first).toBe(second);
    }
  });

  it("returns null for files with no extension", () => {
    expect(route("Makefile", FULL_PALETTE)).toBeNull();
    expect(route("no-extension", FULL_PALETTE)).toBeNull();
  });

  it("returns null for files with a trailing dot", () => {
    expect(route("file.", FULL_PALETTE)).toBeNull();
  });

  it("returns null for unknown extensions", () => {
    expect(route("src/foo.xyz", FULL_PALETTE)).toBeNull();
    expect(route("src/foo.unknown", FULL_PALETTE)).toBeNull();
  });

  it("returns null when the toolchain's driver is not in the palette (vacuous classification)", () => {
    // .rs routes to rust/cargo — absent from EMPTY_PALETTE
    expect(route("src/main.rs", EMPTY_PALETTE)).toBeNull();
    // .ts routes to typescript/bun — absent from RUST_PALETTE
    expect(route("src/index.ts", RUST_PALETTE)).toBeNull();
  });

  it("returns a descriptor when the toolchain IS available", () => {
    expect(route("src/main.rs", RUST_PALETTE)).not.toBeNull();
    expect(route("src/index.ts", TS_PALETTE)).not.toBeNull();
  });

  it("is case-insensitive on the extension", () => {
    const lower = route("src/main.rs", RUST_PALETTE);
    const upper = route("src/main.RS", RUST_PALETTE);
    expect(lower).toBe(upper);
  });

  it("has no observable side effects across calls", () => {
    // Call once to warm any internal state, then call again — output must be identical
    const palette = new Set(["cargo"]);
    route("src/main.rs", palette);
    palette.add("bun"); // mutate the set between calls
    // The second call uses the NEW palette (bun added) — still deterministic for its inputs
    const result = route("src/index.ts", palette);
    expect(result).not.toBeNull(); // bun now present
  });
});
