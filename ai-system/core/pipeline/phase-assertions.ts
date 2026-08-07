import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Result } from "@ai-coding/pipeline";

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
 */
export type PhaseAssertion =
  | { readonly kind: "contains"; readonly path: string; readonly needle: string }
  | { readonly kind: "not-contains"; readonly path: string; readonly needle: string }
  | { readonly kind: "exists"; readonly path: string }
  | { readonly kind: "not-exists"; readonly path: string };

const SEPARATOR = " :: ";

/**
 * Parses the text following an `Assert:` directive into a `PhaseAssertion`.
 *
 * Supported grammars:
 * - `contains <path> :: <needle>`
 * - `not-contains <path> :: <needle>`
 * - `exists <path>`
 * - `not-exists <path>`
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

  return {
    ok: false,
    error: new Error(`unknown assertion verb in: "${spec}"`),
  };
}

/**
 * Evaluates a list of structural assertions against a workspace on disk, in
 * order. Returns `{ ok: false }` naming the first violated assertion's kind,
 * path, and (where applicable) needle. Returns `{ ok: true }` when every
 * assertion is satisfied (including the empty list). Never throws --
 * unreadable files are treated as assertion failures for `contains`, and as
 * "nothing to contain" (satisfied) for `not-contains`.
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
          // Missing/unreadable file has nothing to contain -- satisfied.
          break;
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
    }
  }

  return { ok: true, value: undefined };
}
