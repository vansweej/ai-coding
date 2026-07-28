{
  description = "AI Coding OS — TypeScript monorepo for AI coding workflows";

  nixConfig = {
    extra-substituters = [
      "https://nix-community.cachix.org"
    ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    bun2nix = {
      url = "github:nix-community/bun2nix/2.1.2";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, nixpkgs, bun2nix }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];

      # Instantiate pkgs per system with the bun2nix overlay applied.
      # This puts pkgs.bun2nix (the CLI binary + passthru functions) into scope.
      pkgsFor = nixpkgs.lib.genAttrs systems (system:
        import nixpkgs {
          inherit system;
          overlays = [ bun2nix.overlays.default ];
        }
      );

      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f pkgsFor.${system});
    in
    {
      packages = forEachSystem (pkgs: {
        default = pkgs.stdenv.mkDerivation {
          pname = "ai-coding";
          version = "0.1.0";
          src = pkgs.lib.cleanSource ./.;

          nativeBuildInputs = [
            pkgs.bun
            pkgs.bun2nix.hook  # sets up BUN_INSTALL_CACHE_DIR + runs bun install
          ];

          # fetchBunDeps builds the per-package FOD cache from bun.nix.
          # Hashes come from bun.lock's sha512 integrity — no per-platform table.
          bunDeps = pkgs.bun2nix.fetchBunDeps {
            bunNix = ./bun.nix;
          };

          # bun2nix's default isolated linker causes two known issues:
          #   - On darwin: clonefile fails against nix-store permissions
          #   - On both:   lancedb's prebuild resolver may fail to find the .node
          #                addon under an isolated node_modules tree
          # hoisted linker matches bun's own default since 1.3.2 and avoids both.
          # copyfile backend is required on darwin because hardlink/symlink also fail
          # against the store; on linux the default backend is fine.
          bunInstallFlags =
            if pkgs.stdenv.hostPlatform.isDarwin
            then [ "--linker=hoisted" "--backend=copyfile" ]
            else [ "--linker=hoisted" ];

          # ai-coding runs TypeScript source directly via `bun run` — it is not
          # compiled to a binary. Disable bun2nix's default compile + check phases.
          dontUseBunBuild = true;
          dontUseBunCheck = true;

          # The hook's bunNodeModulesInstallPhase runs `bun install --ignore-scripts`.
          # A separate bunLifecycleScriptsPhase then executes any missing lifecycle
          # scripts — including `postinstall`, which would invoke `bun2nix -o bun.nix`
          # inside the Nix sandbox where bun2nix is not a build input and the source
          # tree is read-only. ai-coding needs no lifecycle scripts: LanceDB prebuilds
          # are separate packages already listed in bun.nix, not fetched by scripts.
          dontRunLifecycleScripts = true;

          installPhase = ''
            # Preserve the exact $out shape home-manager depends on:
            #   $out/opencode.json          (home.file source for ~/.config/opencode/opencode.json)
            #   $out/package.json + $out/ai-system/**/*.ts + $out/packages/**/*.ts
            #   $out/tsconfig.json
            #   $out/node_modules/**        (bun install output; workspace:* links resolved)
            # opencode.nix:136 reads $out/opencode.json directly.
            # opencode.nix:156 sets AI_CODING_MONOREPO=$out; tools run
            #   `bun run --cwd $AI_CODING_MONOREPO <script>` against this layout.
            mkdir -p $out
            cp -rP . $out/
          '';

          # Do not repath or strip binaries. The LanceDB prebuilt .node targets
          # standard system library paths and must not be relinked against Nix store
          # paths (same reason as the previous dontFixup = true).
          dontFixup = true;
        };
      });

      checks = forEachSystem (pkgs: {
        # Regenerates bun.nix from bun.lock in a pure sandbox and diffs it against
        # the committed ./bun.nix. Fails `nix flake check` if they differ.
        # This catches: a dep bump with `bun update`, adding a package with
        # `bun add`, or any bun.lock edit that wasn't followed by `bun2nix -o bun.nix`.
        #
        # NOTE: if a workspace package is added/removed, update the cp list below too.
        # To fix a failure: nix develop . --command bun2nix -o bun.nix && git add bun.nix
        bun-nix-fresh = pkgs.runCommand "check-bun-nix-fresh"
          { nativeBuildInputs = [ pkgs.bun2nix ]; }
          ''
            cp ${./bun.lock} bun.lock
            cp ${./package.json} package.json
            mkdir -p packages/codebase packages/embeddings packages/pipeline packages/skills
            cp ${./packages/codebase/package.json}   packages/codebase/package.json
            cp ${./packages/embeddings/package.json} packages/embeddings/package.json
            cp ${./packages/pipeline/package.json}   packages/pipeline/package.json
            cp ${./packages/skills/package.json}     packages/skills/package.json

            bun2nix -o bun-fresh.nix

            if ! diff ${./bun.nix} bun-fresh.nix > /dev/null 2>&1; then
              echo ""
              echo "ERROR: bun.nix is stale — it does not match the current bun.lock."
              echo "Fix: nix develop . --command bun2nix -o bun.nix && git add bun.nix"
              echo ""
              diff ${./bun.nix} bun-fresh.nix || true
              exit 1
            fi

            touch $out
          '';
      });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          # bun: runtime and package manager
          # ollama: local embedding model server (nomic-embed-text) for vector skill retrieval
          # bun2nix: regenerate bun.nix after lockfile changes: bun2nix -o bun.nix
          packages = [
            pkgs.bun
            pkgs.ollama
            pkgs.bun2nix
          ];
        };
      });
    };
}
