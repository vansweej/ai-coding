# Rust Pipeline

The dedicated Rust dev-cycle implementation has been replaced by the unified
`dev-cycle` pipeline. The Rust behavior now lives in `RUST_CONFIG` in
`ai-system/core/pipeline/definitions/language-configs.ts`.

Use a structured plan file with the unified pipeline:

```bash
bun run pipeline dev-cycle ./my-rust-project --language rust --plan ./plans/feature.md --profile hybrid
```

Or use the compatibility alias for single-step input:

```bash
bun run pipeline rust-dev-cycle ./my-rust-project --input "Add a config module"
```

Rust verification still runs:

1. `cargo fmt --check`
2. `cargo clippy -- -D warnings`
3. `cargo test`
4. `cargo tarpaulin`
5. coverage gate at 90%

See [`docs/pipelines.md`](./pipelines.md) for the plan-file format, retry
strategy, auto-commit behavior, and unified pipeline architecture.
