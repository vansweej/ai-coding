# Rust Pipeline

The dedicated Rust dev-cycle implementation has been replaced by the unified
`dev-cycle` pipeline. The Rust behavior now lives in `RUST_CONFIG` in
`ai-system/core/pipeline/definitions/language-configs.ts`.

Use a structured plan file with the unified pipeline (default `local` profile):

```bash
bun run pipeline dev-cycle ./my-rust-project --language rust --plan ./plans/feature.md
```

Or use the compatibility alias for single-step input:

```bash
bun run pipeline rust-dev-cycle ./my-rust-project --input "Add a config module"
```

Rust verification runs:

1. `cargo fmt --check`
2. `cargo check --quiet`
3. `cargo clippy -- -D warnings`
4. `cargo test`
5. `cargo tarpaulin` (advisory — does not fail on non-zero exit)
6. coverage gate at 90% (advisory — warns below threshold, does not fail)

### Sibling context injection

When the `verified-implement-step` runs (used by `phase-runner` / `feature-runner`),
existing Rust source files in the `src/` directory are automatically read and
injected into the LLM prompt as context. This helps the model generate code that
is aware of existing module structure, type definitions, and function signatures.
Discovery is capped at 10 files / 8 KB total content.

See [`docs/pipelines.md`](./pipelines.md) for the plan-file format, retry
strategy, auto-commit behavior, and unified pipeline architecture.
