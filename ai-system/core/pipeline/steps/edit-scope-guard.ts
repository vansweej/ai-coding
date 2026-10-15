/**
 * A detected edit-scope violation: a REPLACE body that would silently destroy
 * or elide existing SEARCH content. `offendingLine` is the exact line that
 * triggered the rule (the elision placeholder or echoed marker introduced in
 * REPLACE, or the substituted non-ASCII SEARCH comment line).
 */
export interface EditScopeViolation {
  readonly rule: "elision-placeholder" | "non-ascii-destruction" | "truncation-marker-echo";
  readonly offendingLine: string;
  readonly message: string;
}

/**
 * Environment variable that, when set to exactly `off` (trimmed, lowercased),
 * disables the entire edit-scope pre-pass.
 */
export const EDIT_SCOPE_GUARD_ENV = "AI_CODING_EDIT_SCOPE_GUARD";

/**
 * The edit-scope guard is enabled by default. It is disabled ONLY when
 * `AI_CODING_EDIT_SCOPE_GUARD`, trimmed and lowercased, is exactly `off`.
 * Every other value -- unset, `on`, `0`, `true`, `false` -- leaves it enabled.
 *
 * @param env - An environment map (typically `process.env`).
 * @returns `false` only for an explicit `off`; otherwise `true`.
 */
export function isEditScopeGuardEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env[EDIT_SCOPE_GUARD_ENV];
  if (raw === undefined) return true;
  return raw.trim().toLowerCase() !== "off";
}

/**
 * Prompt-context truncation marker introduced in retry file context (P2). A
 * model must never echo it into a REPLACE body -- doing so would overwrite the
 * truncated tail with the marker text.
 */
const TRUNCATION_MARKER = "[ai-coding: truncated";

/**
 * File extensions whose content is prose, where R1 (elision) and R2 (non-ASCII
 * substitution) must NOT fire -- a `## Unchanged` heading or a `---` rule is
 * legitimate content. R3 (truncation marker) still applies everywhere.
 */
const PROSE_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdx", ".markdown", ".txt"]);

/**
 * True when `filePath`'s lowercased extension denotes a prose file.
 *
 * @param filePath - The edit's target path.
 * @returns Whether R1/R2 should be skipped for this file.
 */
export function isProseFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return PROSE_EXTENSIONS.has(lower.slice(dot));
}

/**
 * Phrase-level elision patterns, anchored so the comment BODY must essentially
 * BE the placeholder (optionally ellipsis-prefixed). Deliberately narrow: an
 * ordinary comment that merely MENTIONS "existing code" or "unchanged" mid-
 * sentence (e.g. `// refactor existing code paths`) is NOT a violation.
 */
const ELISION_BODY_PATTERNS: readonly RegExp[] = [
  /^(\.\.\.|\u2026)?\s*existing code(\s*(\.\.\.|\u2026))?$/i,
  /^(\.\.\.|\u2026)?\s*rest of (the )?(file|code|function|implementation|class|module)(\s+(unchanged|remains( the same)?))?(\s*(\.\.\.|\u2026))?$/i,
  /^(\.\.\.|\u2026)?\s*(code |content )?(remains|stays) (unchanged|the same)(\s*(\.\.\.|\u2026))?$/i,
  /^(\.\.\.|\u2026)?\s*unchanged(\s*(\.\.\.|\u2026))?$/i,
  /^(\.\.\.|\u2026)?\s*same as before(\s*(\.\.\.|\u2026))?$/i,
  /^(\.\.\.|\u2026)?\s*(omitted|elided) for brevity(\s*(\.\.\.|\u2026))?$/i,
];

function isCommentLine(trimmed: string): boolean {
  if (trimmed.startsWith("//")) return true;
  if (trimmed.startsWith("/*")) return true;
  if (trimmed.startsWith("--")) return true;
  if (trimmed.startsWith("<!--")) return true;
  // `*` is a comment prefix ONLY when it is bare, followed by a space, or a
  // `/` -- so a C/Rust deref like `*ptr = 5;` is not treated as a comment.
  if (trimmed === "*" || trimmed.startsWith("* ") || trimmed.startsWith("*/")) return true;
  // `#` is a comment, EXCEPT Rust attributes `#[...]` / `#![...]`.
  if (trimmed.startsWith("#") && !trimmed.startsWith("#[") && !trimmed.startsWith("#![")) {
    return true;
  }
  return false;
}

/**
 * The comment-token FAMILY of a trimmed comment line. Tokens are compared by
 * family rather than exact prefix: the `//` family collapses `//`, `///`, and
 * `//!`; the block family collapses `/*`, `/**`, `*`, and the block-close token; and `#`, `--`,
 * and `<!--` are each their own family. Longest prefixes are checked first so a
 * `//`-family or block-family line is mapped before the shorter overlaps.
 * Returns the empty string for a non-comment line.
 */
function commentToken(trimmed: string): string {
  if (trimmed.startsWith("<!--")) return "<!--";
  if (trimmed.startsWith("///") || trimmed.startsWith("//!") || trimmed.startsWith("//")) {
    return "//";
  }
  if (
    trimmed.startsWith("/**") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*/") ||
    trimmed === "*" ||
    trimmed.startsWith("* ")
  ) {
    return "*";
  }
  if (trimmed.startsWith("--")) return "--";
  if (trimmed.startsWith("#") && !trimmed.startsWith("#[") && !trimmed.startsWith("#![")) {
    return "#";
  }
  return "";
}

function commentBody(trimmed: string): string {
  return trimmed
    .replace(/^<!--/, "")
    .replace(/-->$/, "")
    .replace(/^\/\*+/, "")
    .replace(/\*\/$/, "")
    .replace(/^(\/\/\/|\/\/!|\/\/|#!|#|\*\/|\*|--)/, "")
    .trim();
}

function isElisionComment(trimmed: string): boolean {
  const body = commentBody(trimmed);
  if (body === "..." || body === "\u2026") return true;
  if (
    (body.startsWith("...") || body.startsWith("\u2026")) &&
    (body.endsWith("...") || body.endsWith("\u2026"))
  ) {
    return true;
  }
  return ELISION_BODY_PATTERNS.some((re) => re.test(body));
}

function hasNonAscii(line: string): boolean {
  for (const ch of line) {
    const code = ch.codePointAt(0);
    if (code !== undefined && code > 127) return true;
  }
  return false;
}

function nonAsciiChars(line: string): string[] {
  return [...line].filter((ch) => {
    const code = ch.codePointAt(0);
    return code !== undefined && code > 127;
  });
}

/**
 * Check a single edit's SEARCH/REPLACE pair for conservative scope violations.
 *
 * R1 (elision placeholder): REPLACE introduces a comment line absent from
 * SEARCH whose body IS an elision placeholder (ellipsis-only/-bounded, or a
 * known anchored elision phrase). R2 (non-ASCII substitution): a SEARCH COMMENT
 * line containing non-ASCII characters is dropped (no trim-equal REPLACE line
 * and none of its non-ASCII characters appear anywhere in REPLACE) AND REPLACE
 * introduces a new comment line of the SAME comment-token FAMILY -- the
 * substitution shape. Plain deletions and different-family rewrites are allowed.
 * R3 (truncation-marker echo): REPLACE contains the prompt-context truncation
 * marker while SEARCH does not.
 *
 * R1 and R2 are skipped for prose files (`isProseFile`); R3 applies everywhere.
 * Returns `ok` when the edit is in scope. Never throws.
 *
 * @param search - The edit's SEARCH body.
 * @param replace - The edit's REPLACE body.
 * @param filePath - The edit's target path (drives the prose-file skip).
 * @returns A `Result<void, EditScopeViolation>`.
 */
export function checkEditScope(
  search: string,
  replace: string,
  filePath: string,
): { ok: true; value: undefined } | { ok: false; error: EditScopeViolation } {
  const searchLines = search.split("\n");
  const replaceLines = replace.split("\n");
  const searchTrimmed = new Set(searchLines.map((l) => l.trim()));
  const replaceTrimmedSet = new Set(replaceLines.map((l) => l.trim()));
  const replaceJoined = replaceLines.join("\n");

  // R3: truncation-marker echo. The marker is a prompt-context artifact and
  // must never be written into file content. Applies to EVERY file type.
  if (replaceJoined.includes(TRUNCATION_MARKER) && !search.includes(TRUNCATION_MARKER)) {
    const offending = replaceLines.find((l) => l.includes(TRUNCATION_MARKER)) ?? TRUNCATION_MARKER;
    return {
      ok: false,
      error: {
        rule: "truncation-marker-echo",
        offendingLine: offending,
        message: `REPLACE contains the prompt-context truncation marker "${TRUNCATION_MARKER}...]", which is a retry-context artifact, NOT file content. Emit the full original text in place of the marker; never write it into the file.`,
      },
    };
  }

  // R1 and R2 are prose-sensitive: `## Unchanged` and `---` are legit content.
  if (isProseFile(filePath)) {
    return { ok: true, value: undefined };
  }

  // Comment lines newly introduced in REPLACE (trimmed, absent from SEARCH),
  // paired with their comment-token family -- the substitution candidates
  // for R2 and the scan set for R1.
  const introducedComments: { trimmed: string; token: string }[] = [];
  for (const line of replaceLines) {
    const trimmed = line.trim();
    if (!isCommentLine(trimmed)) continue;
    if (searchTrimmed.has(trimmed)) continue;
    introducedComments.push({ trimmed, token: commentToken(trimmed) });
  }

  // R1: elision placeholder.
  for (const { trimmed } of introducedComments) {
    if (isElisionComment(trimmed)) {
      return {
        ok: false,
        error: {
          rule: "elision-placeholder",
          offendingLine: trimmed,
          message: `REPLACE introduces an elision placeholder "${trimmed}" not present in SEARCH. Emit the full replacement text; preserve existing lines verbatim.`,
        },
      };
    }
  }

  // R2: non-ASCII substitution. A dropped non-ASCII SEARCH COMMENT line that is
  // replaced by a newly introduced same-family comment line is a silent
  // substitution (the live incident). Plain deletions and different-family
  // rewrites are allowed.
  for (const line of searchLines) {
    const trimmed = line.trim();
    if (!hasNonAscii(line)) continue;
    if (!isCommentLine(trimmed)) continue;
    if (replaceTrimmedSet.has(trimmed)) continue;
    const chars = nonAsciiChars(line);
    if (chars.some((ch) => replaceJoined.includes(ch))) continue;
    const token = commentToken(trimmed);
    const substituted = introducedComments.some((c) => c.token === token);
    if (substituted) {
      return {
        ok: false,
        error: {
          rule: "non-ascii-destruction",
          offendingLine: line,
          message: `SEARCH comment line "${trimmed}" contains non-ASCII characters and was replaced by a new same-family comment in REPLACE. Preserve the original line verbatim; do not substitute a placeholder for it.`,
        },
      };
    }
  }

  return { ok: true, value: undefined };
}
