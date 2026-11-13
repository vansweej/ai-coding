/**
 * Extract a short "first failure" summary from a failed gate's captured
 * output. Pure and total: never throws, always returns a string (possibly
 * empty). Toolchain-specific heuristics are tried in order; the final
 * fallback is the first 20 non-empty lines of stderr.
 *
 * @param stdout - The gate's captured standard output.
 * @param stderr - The gate's captured standard error.
 * @returns A short human-readable summary, or "" when nothing matched.
 */
export function summarizeGateFailure(stdout: string, stderr: string): string {
  const cargo = summarizeCargoTest(stdout);
  if (cargo !== "") return cargo;

  const rustc = summarizeRustcLike(stderr) || summarizeRustcLike(stdout);
  if (rustc !== "") return rustc;

  const bun = summarizeBunTest(stdout) || summarizeBunTest(stderr);
  if (bun !== "") return bun;

  const fallback = stderr
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, 20);
  return fallback.join("\n");
}

/**
 * The first `---- <name> stdout ----` block of a `cargo test` run, up to the
 * next blank line or a `failures:` line, which includes its `panicked at` line.
 */
function summarizeCargoTest(stdout: string): string {
  const lines = stdout.split("\n");
  const start = lines.findIndex(
    (line) => line.trimStart().startsWith("---- ") && line.trimEnd().endsWith(" stdout ----"),
  );
  if (start === -1) return "";
  const collected: string[] = [lines[start] ?? ""];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") break;
    if (line.trimStart().startsWith("failures:")) break;
    collected.push(line);
  }
  return collected.join("\n");
}

/**
 * The first `error[...]`, `error:`, or `warning:` line emitted by rustc or
 * clippy, plus its following `--> path:line:col` location line when present.
 */
function summarizeRustcLike(text: string): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => {
    const trimmed = line.trimStart();
    return (
      trimmed.startsWith("error[") || trimmed.startsWith("error:") || trimmed.startsWith("warning:")
    );
  });
  if (index === -1) return "";
  const collected: string[] = [lines[index] ?? ""];
  const next = lines[index + 1] ?? "";
  if (next.trimStart().startsWith("-->")) collected.push(next);
  return collected.join("\n");
}

/**
 * The first `(fail)` line of a `bun test` run, plus the first following
 * `error:` or `expect(` line.
 */
function summarizeBunTest(text: string): string {
  const lines = text.split("\n");
  const failIndex = lines.findIndex((line) => line.includes("(fail)"));
  if (failIndex === -1) return "";
  const collected: string[] = [lines[failIndex] ?? ""];
  for (let index = failIndex + 1; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trimStart();
    if (trimmed.startsWith("error:") || trimmed.startsWith("expect(")) {
      collected.push(lines[index] ?? "");
      break;
    }
  }
  return collected.join("\n");
}
