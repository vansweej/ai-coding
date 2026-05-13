# CMake Pipeline

The dedicated CMake dev-cycle implementation has been replaced by the unified
`dev-cycle` pipeline. The C++ behavior now lives in `CPP_CONFIG` in
`ai-system/core/pipeline/definitions/language-configs.ts`.

Use a structured plan file with the unified pipeline:

```bash
bun run pipeline dev-cycle ./my-cpp-project --language cpp --plan ./plans/feature.md --profile hybrid
```

Or use the compatibility alias for single-step input:

```bash
bun run pipeline cmake-dev-cycle ./my-cpp-project --input "Add a matrix multiply function"
```

C++ verification still runs:

1. `cmake -S . -B build`
2. `cmake --build build`
3. `ctest --test-dir build --output-on-failure`

See [`docs/pipelines.md`](./pipelines.md) for the plan-file format, retry
strategy, auto-commit behavior, and unified pipeline architecture.
