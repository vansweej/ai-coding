# Plan Cycle — Per-Language Reference

Companion reference to [`docs/plan-cycle.md`](plan-cycle.md), covering the toolchain, Nix flake
dev-shell prerequisites, and known caveats for each of the 8 languages registered in
`PLAN_CONFIG_FACTORIES` (`ai-system/core/pipeline/definitions/language-configs.ts`).

## Token Cap Note

Before multi-file plan-cycle patches were reliable, implement/fix LLM calls were silently capped
at 4096 output tokens: `AnthropicDispatcher`'s `DEFAULT_MAX_TOKENS` defaulted to 4096, and neither
`verified-implement-step.ts` nor `dev-cycle.ts` set an explicit `maxTokens` on their LLM call
options, so large multi-file patches were truncated mid-patch — surfacing as
`parsePatch: "unterminated REPLACE block"` errors. This was **provider-independent**: the
Anthropic API's own default is also 4096, and the Copilot dispatcher omits `max_tokens` entirely
(falling back to the server's default).

Both the dispatcher default and every implement/fix call site now explicitly request
**`maxTokens: 8192`**. If you still see truncated patches on very large phases, consider
splitting the phase into smaller steps rather than raising this further — 8192 already
comfortably covers multi-file changes of the size plan-cycle typically produces per phase.

---

## Per-Language Toolchain and Prerequisites

Every `createNixShellStep` wraps its command in `nix develop --command` only when the target
workspace has a `flake.nix`; otherwise it runs the command directly against `PATH`. **The target
workspace, not the ai-coding monorepo, must expose these tools** — either via its own flake
dev-shell or by having them already on `PATH`.

### Rust — `--language rust` (also `rust-plan-cycle` alias)

| Step | Command | Notes |
|------|---------|-------|
| `fmt` | `cargo fmt` | Autofix (not `--check`) — plan-cycle's Rust config always reformats |
| `check` | `cargo check --quiet` | |
| `clippy` | `cargo clippy -- -D warnings` | Fatal on any warning |
| `test` | `cargo test` | |
| `tarpaulin` | `cargo tarpaulin` | `failOnNonZero: false` — feeds the coverage gate, doesn't fail on its own |
| `coverage` | Coverage gate | **Fatal.** Threshold from the phase's `Coverage:` directive (default 90%), with auto-exempt for zero-line-addition diffs |

Requires: `cargo`, `rustc`, `cargo-tarpaulin`, `clippy` component.

### TypeScript — `--language typescript` (also the overall fallback default)

| Step | Command | Timeout |
|------|---------|---------|
| `typecheck` | `bun run typecheck` | default (60s) |
| `lint` | `bunx biome check --write .` | default (60s) |
| `test` | `bun test` | 300s |

No coverage gate. Requires: `bun`, a `package.json` with a `typecheck` script, and Biome
available via `bunx`.

### Python — `--language python`

| Step | Command | Timeout | Fatal? |
|------|---------|---------|:---:|
| `format` | `ruff format --check .` | 60s | ✅ |
| `lint` | `ruff check .` | 60s | ✅ |
| `typecheck` | `mypy .` | 120s | ❌ warning-only |
| `test` | `pytest -q` | 300s | ✅ |

**`mypy` is warning-only** deliberately — most target repos are not fully typed yet. Tighten
this to fatal once the project's type coverage is high enough that mypy failures reliably
indicate real bugs rather than pre-existing untyped code. `ruff` and `pytest` stay fatal from
day one since they don't have this maturity problem.

Requires: `python3`, `ruff`, `mypy`, `pytest` on the flake dev-shell or `PATH`.

### C++ — `--language cpp`

| Step | Command | Timeout |
|------|---------|---------|
| `configure` | `cmake -S . -B build` | 120s |
| `build` | `cmake --build build` | 300s |
| `test` | `ctest --test-dir build --output-on-failure` | 300s |

No coverage gate. Requires: `cmake`, a C++ toolchain (`gcc`/`clang`), `ctest`.

### Haskell — `--language haskell`

| Step | Command | Timeout |
|------|---------|---------|
| `build` | `cabal build` | 600s |
| `lint` | `hlint .` | 120s |
| `test` | `cabal test` | 600s |

`cabal build` doubles as the typecheck step — GHC's compile step is the primary type-safety
signal for Haskell, so there is no separate `typecheck` step. The 600s timeouts accommodate
GHC's comparatively slow compile times, especially on a cold build cache.

Requires: `ghc`, `cabal-install`, `hlint`.

### Julia — `--language julia`

| Step | Command | Timeout |
|------|---------|---------|
| `test` | `julia --project -e 'using Pkg; Pkg.test()'` | 900s |

**Weak verification** — this is the only toolchain step. There is no separate format or lint
step for Julia today (no equivalent of `ruff`/`hlint` wired in yet). `Pkg.test()` only catches
what the project's own test suite exercises; a phase can pass verification while still having
style or type-stability issues a linter would flag. The 900s timeout accounts for Julia's package
precompilation overhead, which is substantial on a cold run.

Requires: `julia` with the project's `Project.toml`/`Manifest.toml` resolved.

### Nix — `--language nix`

| Step | Command | Timeout |
|------|---------|---------|
| `format` | `nixpkgs-fmt --check .` | 60s |
| `check` | `nix flake check` | 900s |

**`baselineCheck: true`** — see [Baseline-Green Languages](#baseline-green-languages-nix-and-shell)
below. `nix flake check` cannot be scoped to a diff (it evaluates the whole flake), so it runs
once on the untouched tree before any implementation attempt, and its cost is paid **twice per
phase** (once as the baseline check, once as post-implementation verification) — accepted as a
known cost of whole-repo validation. The 900s timeout accounts for flake evaluation, which can be
slow on repos with many outputs or a large `nixpkgs` pin.

Requires: `nix` (flakes enabled), `nixpkgs-fmt`.

### Shell — `--language shell`

| Step | Command | Timeout |
|------|---------|---------|
| `format` | `shfmt -d .` | 60s |
| `lint` | `sh -c 'files=$(git ls-files "*.sh"); [ -z "$files" ] || shellcheck $files'` | 120s |

**`baselineCheck: true`** — see [Baseline-Green Languages](#baseline-green-languages-nix-and-shell)
below. The `lint` step is guarded: `shellcheck` itself exits non-zero with "no files specified"
when given an empty file list, so the wrapper lists tracked `.sh` files via `git ls-files` first
and only invokes `shellcheck` when that list is non-empty. This means a repo with no shell
scripts yet passes cleanly rather than failing on shellcheck's own argument-count check.

Requires: `shfmt`, `shellcheck`.

---

## Baseline-Green Languages (Nix and Shell)

Nix and Shell are the only two languages with `baselineCheck: true` today. Both have a toolchain
step that validates the **whole repository** rather than just the files a phase touches
(`nix flake check` evaluates the entire flake; `shellcheck` here is invoked over every tracked
`.sh` file, not just changed ones). Neither can be meaningfully scoped to a diff, so if the repo
was already broken before a plan-cycle run started, the phase's own implementation would
otherwise get blamed for a pre-existing problem.

To avoid that, `runPhase` runs the resolved language config's `toolchainSteps` once against the
**untouched tree**, before any implementation attempt, whenever `baselineCheck` is set. A failure
here is wrapped in `BaselineCheckError` and propagates as an **environment error (exit code 3)**
rather than a retryable phase failure (exit code 2) — retrying the implementation cannot fix a
problem that predates it.

This means Nix and Shell phases pay their whole-repo validation cost **twice**: once as the
baseline check, once again as post-implementation verification. This is an accepted tradeoff —
see [`nix flake check`](#nix--language-nix) above for the specific cost.

No other language sets `baselineCheck` today; their toolchain steps operate on the working tree
as modified by the phase's implementation, which is sufficient since none of their validators are
inherently whole-repo-only.

---

## Adding a New Language

1. Add the language to `LanguageName` in `ai-system/core/pipeline/plan-parser.ts` and to
   `KNOWN_LANGUAGES`.
2. Add a `create<Lang>PlanConfig(coverage, diff): DevCycleLanguageConfig` factory in
   `language-configs.ts`, using `buildPatchSystem(languageHint, idioms)` for the implement
   system prompt (keeps the aider-style SEARCH/REPLACE format consistent across languages).
3. Declare `sourceExtensions` and `sourceRoots` so `buildBaselineContext`/
   `readCurrentFileContents` can discover the language's source files for prompt context.
4. Set `baselineCheck: true` only if the toolchain includes a validator that cannot be scoped to
   a diff.
5. Give every `createNixShellStep` an explicit `timeoutMs` — the shell-step default (60s) is too
   low for most build/test tools.
6. Register the factory in `PLAN_CONFIG_FACTORIES`.
7. Add a row to the [Per-Language Toolchain and Prerequisites](#per-language-toolchain-and-prerequisites)
   table above, documenting required flake dev-shell tools.

---

## See Also

- [`docs/plan-cycle.md`](plan-cycle.md) — Main plan-cycle guide: plan file format, usage, resume
  workflow, exit codes
- [`docs/architecture.md`](architecture.md) — System-wide architecture and model routing
