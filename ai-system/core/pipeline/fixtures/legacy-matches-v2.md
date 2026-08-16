# Feature: Legacy matches v2 fixture

## Phase 1: Verify grammar verbs

Commit message: test: add legacy-matches-v2 fixture

Assert: exists ai-system/core/pipeline/fixtures/legacy-matches-v2.md
Assert: matches ai-system/core/pipeline/fixtures/legacy-matches-v2.md :: exists .+
Assert: contains ai-system/core/pipeline/fixtures/legacy-matches-v2.md :: toml-keys
Assert: contains ai-system/core/pipeline/fixtures/legacy-matches-v2.md :: matches

### Step 1: Create fixture

This file is the fixture. No implementation required.