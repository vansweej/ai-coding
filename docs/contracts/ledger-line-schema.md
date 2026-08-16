# Ledger-Line Schema Contract (v1)

This document is the **cross-repo shared contract** between `ai-coding` and
`choragos`. Every consumer of the JSON-lines ledger file, and every emitter,
must conform to this specification. Changes that break backward-compatibility
require a major version bump and a migration window (see [Compatibility
Policy](#compatibility-policy)).

---

## Ledger File Format

The ledger is a **JSON-lines** file: one complete JSON object per line, no
trailing comma, UTF-8 encoded. Each line is a **ledger line**.

---

## Ledger Line: Required Fields

| Field          | Type    | Description                                                                 |
|----------------|---------|-----------------------------------------------------------------------------|
| `schema_version` | `int` | Schema version integer. Starts at `1`. Consumers must reject lines where this field is missing or not a positive integer. |
| `runId`        | `string` | Opaque run identifier. Minted once per `plan-cycle` invocation; stable across all lines of a single run. |
| `ts`           | `string` | RFC 3339 timestamp of when the line was emitted (e.g. `2026-08-16T12:00:00.000Z`). |
| `kind`         | `string` | Discriminant identifying the line type. See [Known Kinds](#known-kinds). Unknown kinds must be accepted (forward-compat). |

---

## Ledger Line: Optional Fields

| Field   | Type     | Description                                                              |
|---------|----------|--------------------------------------------------------------------------|
| `phase` | `int`    | 1-based phase number. Present on phase-scoped lines.                     |
| `step`  | `int`    | 1-based step number within a phase. Present on step-scoped lines.       |
| `opId`  | `string` | Correlation identifier linking a ledger line to a specific patch op.    |
| `payload` | `object` | Kind-specific fields. Shape defined per kind below. Unknown payload fields must be accepted (forward-compat). |

---

## Known Kinds

### `phase-start`

Emitted at the beginning of each phase.

| Payload field | Type   | Description                        |
|---------------|--------|------------------------------------|
| `commitMsg`   | string | The commit message for this phase. |

### `step`

Emitted when a step completes (success or failure).

| Payload field | Type    | Description                                      |
|---------------|---------|--------------------------------------------------|
| `status`      | string  | `"ok"`, `"failed"`, or `"retrying"`.            |
| `attempt`     | int     | 1-based attempt number.                          |
| `detail`      | string? | Optional human-readable detail string.           |

### `gate-output`

Emitted for each verification gate run (typecheck, lint, test, etc.).

| Payload field | Type   | Description                              |
|---------------|--------|------------------------------------------|
| `gate`        | string | Gate name (e.g. `"typecheck"`, `"test"`). |
| `exitCode`    | int    | Exit code of the gate command.           |
| `opId`        | string? | Optional: links to a patch op.          |

### `degraded-exit`

Emitted when a run completes with non-fatal degradations (exit code 4).

| Payload field  | Type     | Description                             |
|----------------|----------|-----------------------------------------|
| `degradations` | string[] | List of human-readable degradation reasons. |

### `vacuous-pass`

Emitted when a phase is committed despite no net working-tree change (guard
violation surfaced for audit; the pipeline should block this condition — this
kind records its detection).

| Payload field | Type   | Description                    |
|---------------|--------|--------------------------------|
| `phase`       | int    | Phase number where detected.   |

### `diagnosis`

Emitted by the self-diagnosis subsystem.

| Payload field | Type   | Description                                             |
|---------------|--------|---------------------------------------------------------|
| `check`       | string | Name of the diagnostic check (e.g. `"dispatcher-reachable"`). |
| `status`      | string | `"ok"` or `"fail"`.                                    |
| `detail`      | string? | Optional detail string.                               |

### `run-shape`

Emitted once per run (typically before the first phase) summarising the run
parameters. Useful for dry-run predictions.

| Payload field | Type     | Description                                         |
|---------------|----------|-----------------------------------------------------|
| `profile`     | string   | The model profile name used for this run.           |
| `phases`      | int      | Total number of phases in the plan.                |
| `dryRun`      | boolean  | Whether the run is in dry-run mode.                |

---

## Stdout Locator Line

Before (or immediately after) the ledger file is opened, the pipeline emits a
**single, stable, greppable line** on stdout:

```
CHORAGOS-LEDGER runId=<id> path=<abs-path>
```

Where:

- `<id>` is the `runId` for this run (no spaces).
- `<abs-path>` is the absolute filesystem path to the JSON-lines ledger file.

**Both repos** must use the following regex to parse the locator:

```
^CHORAGOS-LEDGER runId=(\S+) path=(.+)$
```

Group 1 = `runId`, Group 2 = `abs-path`.

The locator is emitted to stdout exactly once per run. It is not a ledger
line itself (it is plain text, not JSON).

---

## Compatibility Policy

> **Version N accepts implies version N+1 must accept**, or the change
> constitutes a major version bump requiring a migration window.

Concretely:

- New optional fields may be added to any line at any time (minor change, no
  bump required) — consumers must ignore unknown fields.
- New `kind` values may be added at any time — consumers must accept unknown
  kinds without error.
- Removing or renaming a required field, or changing the type of any field, is
  a major breaking change and requires bumping `schema_version`.

This policy is enforced by a **golden-fixture forward-accept test** in both
repos: `golden-v1.jsonl` (this repo) and its vendor copy in choragos (landed
as S9a Phase 1). Any future parser must parse every line in the v1 golden
fixture without error.

---

## Cross-Repo Notes

- The canonical golden fixture is `test/fixtures/ledger/golden-v1.jsonl` in
  this repo. The choragos repo vendors an identical copy.
- The choragos-side round-trip test and `LedgerRecord` schema upgrade land as
  **S9a** in the Trustworthy Plan-Cycle initiative.
- The `runId` field is the primary correlation key between choragos ledger
  records and the JSON-lines ledger file emitted by `ai-coding`.
