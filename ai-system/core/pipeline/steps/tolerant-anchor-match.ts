import type { Result } from "@ai-coding/shared";

/**
 * A pure, side-effect-free, language-agnostic matcher that recovers EDIT
 * anchors the model paraphrased by dropping interleaved lines physically
 * present on disk (e.g. comments). It hardcodes no comment tokens for any
 * language -- it relies only on the universal notion of a blank line as a
 * region boundary -- and it is fail-closed: any ambiguity or absence of a
 * match returns an error rather than guessing.
 *
 * This function never mutates; it only computes offsets. The caller splices
 * `content` by the returned `{ startOffset, endOffset }` pair.
 */

interface ContentLine {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Comparison key for a single line: leading whitespace is preserved and
 * compared strictly (never trimmed), while internal/inter-token whitespace
 * runs are collapsed to a single space. Two lines are equal iff BOTH the
 * leading whitespace and the collapsed remainder are equal.
 *
 * Residual: because internal runs are collapsed, a string literal such as
 * `"a    b"` would compare equal to `"a b"`. This is an accepted, documented
 * residual -- indentation strictness is the guaranteed invariant, not
 * language-aware string-literal parsing.
 */
interface LineKey {
  readonly leadingWhitespace: string;
  readonly collapsedRemainder: string;
}

function normalizeLine(line: string): LineKey {
  const withoutCr = line.replace(/\r$/, "").replace(/[ \t]+$/, "");
  const match = /^([ \t]*)([\s\S]*)$/.exec(withoutCr);
  const leadingWhitespace = match?.[1] ?? "";
  const remainder = match?.[2] ?? "";
  const collapsedRemainder = remainder.replace(/[ \t]+/g, " ");
  return { leadingWhitespace, collapsedRemainder };
}

function lineKeysEqual(a: LineKey, b: LineKey): boolean {
  return (
    a.leadingWhitespace === b.leadingWhitespace && a.collapsedRemainder === b.collapsedRemainder
  );
}

function isBoundaryBlank(key: LineKey): boolean {
  return key.collapsedRemainder.length === 0;
}

/**
 * Split `content` into lines, retaining each line's byte offsets in the
 * ORIGINAL string (so offsets index back correctly regardless of `\n` vs
 * `\r\n` terminators).
 */
function splitContentLines(content: string): ContentLine[] {
  const lines: ContentLine[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === "\n") {
      lines.push({ text: content.slice(start, i), startOffset: start, endOffset: i });
      start = i + 1;
    }
  }
  lines.push({ text: content.slice(start), startOffset: start, endOffset: content.length });
  return lines;
}

// Secondary sanity cap on absorbed extras within a contiguous non-blank run.
// The blank-line boundary is authoritative; this cap only guards against
// pathological runaway walks and is kept generous.
const ABSORB_CAP_MULTIPLIER = 20;

interface CompletedRegion {
  readonly startOffset: number;
  readonly endOffset: number;
}

/**
 * Attempt to complete a region starting at content line index `s`, matching
 * `anchorLineKeys` in order. Returns every completed region found for this
 * start (zero, one, or more than one via end-point ambiguity).
 */
function completeRegionsFromStart(
  contentLines: readonly ContentLine[],
  anchorLineKeys: readonly LineKey[],
  s: number,
): CompletedRegion[] {
  const absorbCap = anchorLineKeys.length * ABSORB_CAP_MULTIPLIER;

  if (anchorLineKeys.length === 1) {
    // The first anchor line is also the last anchor line: the region is the
    // single matched line itself. Multi-start ambiguity (this same line
    // appearing elsewhere) is handled by the caller's outer loop, which
    // visits every matching start independently.
    return [
      {
        startOffset: contentLines[s].startOffset,
        endOffset: contentLines[s].endOffset,
      },
    ];
  }

  // Walk forward matching anchorLineKeys[1 .. length-2] (all but the last),
  // absorbing extras between matches, terminating at a boundary blank.
  let cursor = s + 1;
  let anchorIdx = 1;
  let absorbed = 0;
  const penultimateIdx = anchorLineKeys.length - 2;

  while (anchorIdx <= penultimateIdx && cursor < contentLines.length) {
    const key = normalizeLine(contentLines[cursor].text);
    if (isBoundaryBlank(key)) {
      // Region candidacy terminates: cannot cross a blank line.
      return [];
    }
    if (lineKeysEqual(key, anchorLineKeys[anchorIdx])) {
      anchorIdx += 1;
      cursor += 1;
    } else {
      absorbed += 1;
      if (absorbed > absorbCap) return [];
      cursor += 1;
    }
  }

  if (anchorIdx <= penultimateIdx) {
    // Ran out of content (or hit blank) before matching all but the last.
    return [];
  }

  // Now scan for ALL positions at/after `cursor` where the LAST anchor line
  // matches, within the same non-blank run (before any boundary blank).
  const lastKey = anchorLineKeys[anchorLineKeys.length - 1];
  const endPositions: number[] = [];
  let scan = cursor;
  while (scan < contentLines.length) {
    const key = normalizeLine(contentLines[scan].text);
    if (isBoundaryBlank(key)) break;
    if (lineKeysEqual(key, lastKey)) endPositions.push(scan);
    scan += 1;
  }

  return endPositions.map((p) => ({
    startOffset: contentLines[s].startOffset,
    endOffset: contentLines[p].endOffset,
  }));
}

export function matchTolerantAnchor(
  content: string,
  search: string,
): Result<{ startOffset: number; endOffset: number }, { reason: "not-found" | "ambiguous" }> {
  const anchorLines = search.split("\n");
  if (anchorLines.length === 0) {
    return { ok: false, error: { reason: "not-found" } };
  }
  const anchorLineKeys = anchorLines.map(normalizeLine);

  const contentLines = splitContentLines(content);
  const firstAnchorKey = anchorLineKeys[0];

  const allRegions: CompletedRegion[] = [];
  let startsWithRegions = 0;

  for (let s = 0; s < contentLines.length; s += 1) {
    const key = normalizeLine(contentLines[s].text);
    if (!lineKeysEqual(key, firstAnchorKey)) continue;

    const regions = completeRegionsFromStart(contentLines, anchorLineKeys, s);
    if (regions.length > 0) {
      startsWithRegions += 1;
      allRegions.push(...regions);
    }
  }

  if (allRegions.length === 0) {
    return { ok: false, error: { reason: "not-found" } };
  }

  if (allRegions.length > 1 || startsWithRegions > 1) {
    return { ok: false, error: { reason: "ambiguous" } };
  }

  const region = allRegions[0];
  return { ok: true, value: { startOffset: region.startOffset, endOffset: region.endOffset } };
}
