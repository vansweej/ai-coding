import { describe, expect, it } from "bun:test";

import { type CargoMetadata, computeUncoveredRustFiles } from "./rust-gate-coverage";

/** Exercises the pure workspace-member containment advisory. */
describe("computeUncoveredRustFiles", () => {
  const workspacePath = "/workspace";
  const metadata: CargoMetadata = {
    workspace_root: workspacePath,
    workspace_members: ["member 1.0.0 (path+file:///workspace/crates/member)"],
    packages: [
      {
        id: "member 1.0.0 (path+file:///workspace/crates/member)",
        manifest_path: "/workspace/crates/member/Cargo.toml",
      },
      {
        id: "excluded 1.0.0 (path+file:///workspace/crates/excluded)",
        manifest_path: "/workspace/crates/excluded/Cargo.toml",
      },
    ],
  };

  it("flags a .rs file outside every workspace member directory", () => {
    expect(
      computeUncoveredRustFiles(metadata, ["crates/excluded/src/lib.rs"], workspacePath),
    ).toEqual(["crates/excluded/src/lib.rs"]);
  });

  it("does not flag a .rs file inside a workspace member directory", () => {
    expect(
      computeUncoveredRustFiles(metadata, ["crates/member/src/lib.rs"], workspacePath),
    ).toEqual([]);
  });

  it("ignores non-rust touched files", () => {
    expect(
      computeUncoveredRustFiles(
        metadata,
        ["crates/excluded/README.md", "crates/excluded/Cargo.toml"],
        workspacePath,
      ),
    ).toEqual([]);
  });

  it("returns empty when no files are touched", () => {
    expect(computeUncoveredRustFiles(metadata, [], workspacePath)).toEqual([]);
  });
});
