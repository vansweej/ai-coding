{
  description = "AI Coding OS — TypeScript monorepo for AI coding workflows";

  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Per-platform hash for the bun cache FOD.
      # Each platform downloads different native addons, producing a different output.
      # To discover the hash for a new platform, run:
      #   nix build .#packages.<system>.default
      # and copy the hash from the "got:" line in the error output.
      bunCacheHashes = {
        "aarch64-darwin" = "sha256-IhkAEL/j+YzQsk37IVRSMis4wYWxFuWetUMKtz/+NeM=";
        "x86_64-linux"   = "sha256-IZNQ+EQKZCLnAqqUK8lehxNTUUmH3QutrigJE3QJJps=";
        "aarch64-linux"  = "sha256-g3TMVss4v/lZRMXhpT/0uoEFZ+91U6gD866MoM8xkSs=";
      };
    in
    {
      packages = forEachSystem (pkgs:
        let
          # Minimal source for the cache-fetch FOD: only the lockfile and package
          # manifests. Code-only changes do not invalidate the network-fetching step.
          manifestsSrc = pkgs.runCommand "ai-coding-manifests" { } ''
            mkdir -p $out/packages/codebase \
                     $out/packages/embeddings \
                     $out/packages/pipeline \
                     $out/packages/skills
            cp ${./package.json}                             $out/package.json
            cp ${./bun.lock}                                 $out/bun.lock
            cp ${./packages/codebase/package.json}           $out/packages/codebase/package.json
            cp ${./packages/embeddings/package.json}         $out/packages/embeddings/package.json
            cp ${./packages/pipeline/package.json}           $out/packages/pipeline/package.json
            cp ${./packages/skills/package.json}             $out/packages/skills/package.json
          '';

          # Phase 1: fixed-output derivation — network access allowed, output hash-pinned.
          # Populates the bun package cache from the npm registry.
          # Only rebuilds when bun.lock or a package.json changes.
          bunCache = pkgs.stdenv.mkDerivation {
            name = "ai-coding-bun-cache-${pkgs.bun.version}";
            src = manifestsSrc;

            nativeBuildInputs = [
              pkgs.bun
              pkgs.cacert
            ];

            buildPhase = ''
              export HOME=$TMPDIR/home
              mkdir -p $HOME
              export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
              mkdir -p $BUN_INSTALL_CACHE_DIR
              bun install --frozen-lockfile --no-progress
            '';

            installPhase = ''
              mkdir -p $out
              # Use -L to dereference symlinks: the bun cache contains absolute
              # symlinks pointing into $TMPDIR. Those paths still exist during
              # installPhase (same build), so dereferencing here produces a
              # fully self-contained, symlink-free output in the Nix store.
              cp -rL $TMPDIR/bun-cache/. $out/
            '';

            outputHashAlgo = "sha256";
            outputHashMode = "recursive";
            outputHash = bunCacheHashes.${pkgs.stdenv.hostPlatform.system};
          };

          # Phase 2: main derivation — fully pure, no network access.
          # Copies the full source tree and installs node_modules from the cache.
          default = pkgs.stdenv.mkDerivation {
            pname = "ai-coding";
            version = "0.1.0";
            src = pkgs.lib.cleanSource ./.;

            nativeBuildInputs = [ pkgs.bun ];

            buildPhase = ''
              export HOME=$TMPDIR/home
              mkdir -p $HOME
              # Copy the FOD cache into a writable dir before installing: newer
              # bun versions write temp/lock files into BUN_INSTALL_CACHE_DIR,
              # which fails with "AccessDenied" if it points directly at the
              # read-only ${bunCache} store path. cp -r (not -rL) is sufficient
              # since the FOD's installPhase already dereferenced symlinks.
              cp -r ${bunCache} $TMPDIR/bun-cache
              chmod -R u+w $TMPDIR/bun-cache
              export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
              bun install --frozen-lockfile --no-progress --offline
            '';

            installPhase = ''
              mkdir -p $out
              cp -rP . $out/
            '';

            # Skip ELF patching and stripping — the LanceDB native addon is a
            # pre-built binary targeting standard system library paths and must
            # not be relinked against Nix store paths.
            dontFixup = true;
          };
        in
        { inherit default; });

      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          # bun: runtime and package manager
          # ollama: local embedding model server (nomic-embed-text) for vector skill retrieval
          packages = [
            pkgs.bun
            pkgs.ollama
          ];
        };
      });
    };
}
