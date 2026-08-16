# Feature: Legacy contains grammar fixture

## Phase 1: Example phase

Commit message: chore: example

Assert: contains src/lib.rs :: pub fn
Assert: not-contains src/lib.rs :: todo!()
Assert: not-exists src/old.rs

### Step 1: Example step

Example step body.