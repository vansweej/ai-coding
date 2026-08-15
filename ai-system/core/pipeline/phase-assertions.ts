import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Result } from "@ai-coding/pipeline";
import { parse as parseToml } from "smol-toml";

/**
 * Author-declared, runner-enforced structural invariants for a plan phase.
 *
 * These are parsed from `Assert:` directives in a plan file (see
 * `plan-parser.ts`) and checked by `runPhase` (`phase-runner.ts`) AFTER
 * verification succeeds but BEFORE the phase commits. They exist to close
 * the "false-green" failure mode where a phase's toolchain (build/test/lint)
 * passes even though the phase's declared edits never actually landed (e.g.
 * a partial or mis-applied patch) -- the green gate alone cannot detect
 * this, since it only proves the tree compiles/tests, not that it matches
 * the plan's intent. `Assert:` lines let a plan author encode that intent
 * as a machine-checked fact about the final tree.
 *
 * - `parseAssertion` turns a single directive's text (the part after
 *   `Assert:`) into a `PhaseAssertion`. Never throws; returns a `Result`.
 * - `checkAssertions` evaluates a list of assertions against a workspace on
 *   disk, in order, short-circuiting on the first violation. Never throws;
 *   returns a `Result`.
 *
 * The `matches` kind checks a file's content against an anchored-capable
 * regular expression (compiled with `new RegExp`), rather than a plain
 * substring. It exists to express exact structural invariants that a plain
 * `contains` needle cannot -- e.g. "this table has EXACTLY this one key" --
 * closing the false-green loophole where unrelated surrounding content
 * still satisfies a substring check.
 *
 * The `toml-keys` kind checks that a TOML table (addressed by a dotted
 * path, e.g. `lints.workspace`) has EXACTLY the given set of keys -- no
 * more, no fewer. It is parsed in-process via `smol-toml` and closes the
 * loophole where a `contains`/`matches` substring check on raw TOML text
 * cannot distinguish "this table has exactly these keys" from "this table
 * has these keys plus others" (a superset would still satisfy a substring
 * check). Grammar: `toml-keys <path> :: <dotted.table> :: key1,key2,key3`.
 * Set-equality semantics: superset, subset, and missing-table all FAIL;
 * only an exact key-set match passes. A zero-key table (table exists but
 * is empty) is out of scope -- expressing "this table exists and has no
 * keys" is not supported by this grammar.
 */
export type PhaseAssertion =
  | { readonly kind: "contains"; readonly path: string; readonly needle: string }
  | { readonly kind: "not-contains"; readonly path: string; readonly needle: string }
  | { readonly kind: "exists"; readonly path: string }
  | { readonly kind: "not-exists"; readonly path: string }
  | { readonly kind: "matches"; readonly path: string; readonly pattern: string }
  | {
      readonly kind: "toml-keys";
      readonly path: string;
      readonly table: string;
      readonly keys: readonly string[];
    };

const SEPARATOR = " :: ";

/**
 * Type guard for a "plain" TOML table object -- true only for a genuine
 * key-value table, never for `null`, an array (TOML array-of-tables), or a
 * `Date` (TOML datetime values are parsed as JS `Date` instances by
 * `smol-toml`). Used to walk a dotted table path segment-by-segment and
 * fail descriptively when a segment resolves to something other than a
 * table.
 */
function isPlainTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    Object.prototype.toString.call(value) === "[object Object]"
  );
}

/**
 * Never-throw `Result` wrapper around `smol-toml`'s `parse`. Invalid TOML
 * source is reported as a `Result` error rather than a thrown exception.
 */
function parseTomlSource(source: string): Result<Record<string, unknown>> {
  try {
    return { ok: true, value: parseToml(source) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * The current assert-grammar version. Used for forward-compat policy checks
 * to detect plan files authored against a future grammar version.
 */
export const assertGrammarVersion = 2;

/**
 * Parses the text following an `Assert:` directive into a `PhaseAssertion`.
 *
 * Supported grammars:
 * - `contains <path> :: <needle>`
 * - `not-contains <path> :: <needle>`
 * - `exists <path>`
 * - `not-exists <path>`
 * - `matches <path> :: <regex>`
 *
 * The `::` separator (surrounded by single spaces) splits the path from the
 * needle for the two content-checking verbs; only the FIRST occurrence of
 * ` :: ` is treated as the separator, so a needle may itself contain `::`
 * or further spaces. Never throws.
 */
export function parseAssertion(spec: string): Result<PhaseAssertion> {
  const trimmedSpec = spec.trim();
  const firstSpace = trimmedSpec.indexOf(" ");
  const verb = firstSpace === -1 ? trimmedSpec : trimmedSpec.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : trimmedSpec.slice(firstSpace + 1);

  if (verb === "contains" || verb === "not-contains") {
    const separatorIndex = rest.indexOf(SEPARATOR);
    if (separatorIndex === -1) {
      return {
        ok: false,
        error: new Error(
          `invalid "${verb}" assertion (missing " :: " separator between path and needle): "${spec}"`,
        ),
      };
    }
    const path = rest.slice(0, separatorIndex).trim();
    const needle = rest.slice(separatorIndex + SEPARATOR.length).trim();
    if (path === "") {
      return {
        ok: false,
        error: new Error(`invalid "${verb}" assertion (empty path): "${spec}"`),
      };
    }
    if (needle === "") {
      return {
        ok: false,
        error: new Error(`invalid "${verb}" assertion (empty needle): "${spec}"`),
      };
    }
    return {
      ok: true,
      value:
        verb === "contains"
          ? { kind: "contains", path, needle }
          : { kind: "not-contains", path, needle },
    };
  }

  if (verb === "exists" || verb === "not-exists") {
    const path = rest.trim();
    if (path === "") {
      return {
        ok: false,
        error: new Error(`invalid "${verb}" assertion (empty path): "${spec}"`),
      };
    }
    return {
      ok: true,
      value: verb === "exists" ? { kind: "exists", path } : { kind: "not-exists", path },
    };
  }

  if (verb === "matches") {
    const separatorIndex = rest.indexOf(SEPARATOR);
    if (separatorIndex === -1) {
      return {
        ok: false,
        error: new Error(
          `invalid "matches" assertion (missing " :: " separator between path and pattern): "${spec}"`,
        ),
      };
    }
    const path = rest.slice(0, separatorIndex).trim();
    const pattern = rest.slice(separatorIndex + SEPARATOR.length).trim();
    if (path === "") {
      return {
        ok: false,
        error: new Error(`invalid "matches" assertion (empty path): "${spec}"`),
      };
    }
    if (pattern === "") {
      return {
        ok: false,
        error: new Error(`invalid "matches" assertion (empty pattern): "${spec}"`),
      };
    }
    try {
      new RegExp(pattern);
    } catch {
      return {
        ok: false,
        error: new Error(`invalid "matches" assertion (invalid regex): "${spec}"`),
      };
    }
    return { ok: true, value: { kind: "matches", path, pattern } };
  }

  if (verb === "toml-keys") {
    const firstSeparatorIndex = rest.indexOf(SEPARATOR);
    if (firstSeparatorIndex === -1) {
      return {
        ok: false,
        error: new Error(
          `invalid "toml-keys" assertion (missing " :: " separator between path and table): "${spec}"`,
        ),
      };
    }
    const path = rest.slice(0, firstSeparatorIndex).trim();
    const afterPath = rest.slice(firstSeparatorIndex + SEPARATOR.length);

    const secondSeparatorIndex = afterPath.indexOf(SEPARATOR);
    if (secondSeparatorIndex === -1) {
      return {
        ok: false,
        error: new Error(
          `invalid "toml-keys" assertion (missing " :: " separator between table and keys): "${spec}"`,
        ),
      };
    }
    const table = afterPath.slice(0, secondSeparatorIndex).trim();
    const rawKeys = afterPath.slice(secondSeparatorIndex + SEPARATOR.length);

    const keys = rawKeys
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key !== "");

    if (path === "") {
      return {
        ok: false,
        error: new Error(`invalid "toml-keys" assertion (empty path): "${spec}"`),
      };
    }
    if (table === "") {
      return {
        ok: false,
        error: new Error(`invalid "toml-keys" assertion (empty table): "${spec}"`),
      };
    }
    if (keys.length === 0) {
      return {
        ok: false,
        error: new Error(`invalid "toml-keys" assertion (empty keys): "${spec}"`),
      };
    }
    return { ok: true, value: { kind: "toml-keys", path, table, keys } };
  }

  return {
    ok: false,
    error: new Error(`unknown assertion verb in: "${spec}"`),
  };
}

/**
 * Evaluates a list of structural assertions against a workspace on disk, in
 * order. Returns `{ ok: false }` naming the first violated assertion's kind,
 * path, and (where applicable) needle/pattern. Returns `{ ok: true }` when
 * every assertion is satisfied (including the empty list). Never throws --
 * an unreadable file is a FAILURE for `contains`, `not-contains`, and
 * `matches` alike (absence of a needle, or a pattern match, cannot be proven
 * for a file that cannot be read). `matches` also fails on an invalid regex
 * or on a non-match, never throwing.
 */
export function checkAssertions(
  workspace: string,
  assertions: readonly PhaseAssertion[],
): Result<void> {
  for (const assertion of assertions) {
    const resolvedPath = resolve(workspace, assertion.path);

    switch (assertion.kind) {
      case "exists": {
        if (!existsSync(resolvedPath)) {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: path "${assertion.path}" must exist but does not`,
            ),
          };
        }
        break;
      }
      case "not-exists": {
        if (existsSync(resolvedPath)) {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: path "${assertion.path}" must not exist but does`,
            ),
          };
        }
        break;
      }
      case "contains": {
        let content: string;
        try {
          content = readFileSync(resolvedPath, "utf8");
        } catch {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: file "${assertion.path}" must contain "${assertion.needle}" but could not be read`,
            ),
          };
        }
        if (!content.includes(assertion.needle)) {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: file "${assertion.path}" must contain "${assertion.needle}"`,
            ),
          };
        }
        break;
      }
      case "not-contains": {
        let content: string;
        try {
          content = readFileSync(resolvedPath, "utf8");
        } catch {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: file "${assertion.path}" must not contain "${assertion.needle}" but could not be read`,
            ),
          };
        }
        if (content.includes(assertion.needle)) {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: file "${assertion.path}" must not contain "${assertion.needle}"`,
            ),
          };
        }
        break;
      }
      case "matches": {
        let content: string;
        try {
          content = readFileSync(resolvedPath, "utf8");
        } catch {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: file "${assertion.path}" must match /${assertion.pattern}/ but could not be read`,
            ),
          };
        }
        let regex: RegExp;
        try {
          regex = new RegExp(assertion.pattern);
        } catch {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: assertion for "${assertion.path}" has an invalid regex "${assertion.pattern}"`,
            ),
          };
        }
        if (!regex.test(content)) {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: file "${assertion.path}" must match /${assertion.pattern}/`,
            ),
          };
        }
        break;
      }
      case "toml-keys": {
        let content: string;
        try {
          content = readFileSync(resolvedPath, "utf8");
        } catch {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: file "${assertion.path}" could not be read for toml-keys check on table "${assertion.table}"`,
            ),
          };
        }

        const parsedToml = parseTomlSource(content);
        if (!parsedToml.ok) {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: file "${assertion.path}" is not valid TOML (${parsedToml.error.message})`,
            ),
          };
        }

        const segments = assertion.table.split(".");
        let current: Record<string, unknown> = parsedToml.value;
        let walkedPath = "";
        for (const segment of segments) {
          walkedPath = walkedPath === "" ? segment : `${walkedPath}.${segment}`;
          const next = current[segment];
          if (!isPlainTable(next)) {
            const actualDescription =
              next === undefined
                ? "is missing"
                : next === null
                  ? "is null"
                  : Array.isArray(next)
                    ? "is an array"
                    : next instanceof Date
                      ? "is a datetime"
                      : `is a ${typeof next}`;
            return {
              ok: false,
              error: new Error(
                `Structural assertion failed: file "${assertion.path}" table "${assertion.table}" ${walkedPath} ${actualDescription}, not a table`,
              ),
            };
          }
          current = next;
        }

        const expectedKeys = [...assertion.keys].sort();
        const actualKeys = Object.keys(current).sort();
        const expectedSet = new Set(expectedKeys);
        const actualSet = new Set(actualKeys);
        const extraKeys = actualKeys.filter((key) => !expectedSet.has(key));
        const missingKeys = expectedKeys.filter((key) => !actualSet.has(key));

        if (extraKeys.length > 0 || missingKeys.length > 0) {
          return {
            ok: false,
            error: new Error(
              `Structural assertion failed: file "${assertion.path}" table "${assertion.table}" expected keys [${expectedKeys.join(", ")}] but found [${actualKeys.join(", ")}] (extra: [${extraKeys.join(", ")}], missing: [${missingKeys.join(", ")}])`,
            ),
          };
        }
        break;
      }
    }
  }

  return { ok: true, value: undefined };
}
