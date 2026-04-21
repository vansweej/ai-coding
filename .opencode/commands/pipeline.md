---
description: Run any pipeline by name. Usage: /pipeline <name> <workspace> [--input "..."]
---
Run the pipeline with these arguments: $ARGUMENTS

Execute:
!`bun run --cwd /home/vansweej/Projects/ai-coding pipeline $ARGUMENTS 2>&1`

Report each step's outcome. If the pipeline failed, explain which step failed and why.

Available pipelines:
- scaffold-rust   <workspace>             Rust: cargo init + generate flake.nix
- scaffold-cpp    <workspace>             C++: generate CMakeLists.txt + src/main.cpp + flake.nix
- dev-cycle       <workspace>             TypeScript: plan → implement → test
- rust-dev-cycle  <workspace>             Rust: plan → implement → fmt → clippy → test → coverage
- cmake-dev-cycle <workspace>             C++: plan → implement → configure → build → ctest
