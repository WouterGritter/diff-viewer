import type { UnifiedHunk, UnifiedPatch } from "./unified-patch";

/**
 * Fuzzy unified diff application.
 *
 * Intended for applying patches to a source tree that is only *approximately* the one the
 * patch was made against (e.g. a locally decompiled jar vs. the decompiled + post-processed
 * source a project's patches were generated from). Every hunk is placed independently:
 * first by exact context match nearest to its expected position, then by aligning the hunk's
 * old-side lines against candidate windows of the base (using an LCS diff), tolerating a
 * bounded number of changed, missing or extra context lines.
 *
 * Context lines are always emitted from the *base*, never from the patch, so applying two
 * variants of a patch to the same base yields identical text wherever the variants agree.
 */

export type HunkStatus = "exact" | "fuzzy" | "rejected";

export interface HunkApplyResult {
  status: HunkStatus;
  /** 0-based line index in the base where the hunk's old side was placed */
  position?: number;
  /** Difference between where the hunk landed and where its header said it would */
  offset?: number;
  /** Alignment cost (0 for exact matches) */
  cost: number;
  /** First and last (exclusive) line index of the hunk's new side in the output */
  outputRange?: [number, number];
}

export interface FuzzyApplyResult {
  lines: string[];
  hunks: HunkApplyResult[];
  rejected: number;
}

export interface FuzzyApplyOptions {
  /** Base tolerance for changed/missing/extra context lines per hunk (scaled up for large hunks). */
  maxFuzz?: number;
}

export function normalizeLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

interface PatternLine {
  text: string;
  removed: boolean;
}

function patternOf(hunk: UnifiedHunk): PatternLine[] {
  const out: PatternLine[] = [];
  for (const line of hunk.lines) {
    const m = line.charAt(0);
    if (m === " ") out.push({ text: line.substring(1), removed: false });
    else if (m === "-") out.push({ text: line.substring(1), removed: true });
  }
  return out;
}

interface Alignment {
  /** pattern index -> base line index, or -1 when the pattern line is absent from the base */
  map: Int32Array;
  cost: number;
  exactMatches: number;
  regionStart: number;
  regionEnd: number;
}

const REJECT = Number.POSITIVE_INFINITY;

/**
 * Fitting alignment of the pattern against the base window [windowStart, windowEnd):
 * the whole pattern is aligned to a substring of the window, with leading and trailing
 * window lines free. Matches cost 0, substitutions and interior extra base lines cost 1, and
 * pattern lines absent from the base cost 1 (context) or 2 (removed lines).
 */
function alignWindow(
  pattern: PatternLine[],
  patternNorm: string[],
  baseNorm: string[],
  windowStart: number,
  windowEnd: number,
): Alignment | null {
  const m = pattern.length;
  const n = windowEnd - windowStart;
  if (m === 0 || n === 0) return null;
  const absentCost = (i: number) => (pattern[i].removed ? 2 : 1);

  // dp[i][j]: min cost aligning pattern[0..i) with window[..j); row 0 is all zeros (free leading gap)
  const width = n + 1;
  const dp = new Float64Array((m + 1) * width);
  // 0 = diagonal match, 1 = diagonal substitution, 2 = pattern line absent (up), 3 = extra base line (left)
  const from = new Uint8Array((m + 1) * width);
  for (let i = 1; i <= m; i++) {
    dp[i * width] = dp[(i - 1) * width] + absentCost(i - 1);
    from[i * width] = 2;
  }
  for (let i = 1; i <= m; i++) {
    const pn = patternNorm[i - 1];
    for (let j = 1; j <= n; j++) {
      const idx = i * width + j;
      const match = baseNorm[windowStart + j - 1] === pn;
      let best = dp[(i - 1) * width + j - 1] + (match ? 0 : 1);
      let src = match ? 0 : 1;
      const up = dp[(i - 1) * width + j] + absentCost(i - 1);
      if (up < best) {
        best = up;
        src = 2;
      }
      const left = dp[idx - 1] + 1;
      if (left < best) {
        best = left;
        src = 3;
      }
      dp[idx] = best;
      from[idx] = src;
    }
  }

  // Free trailing gap: pick the cheapest end column
  let endJ = 0;
  let cost = Number.POSITIVE_INFINITY;
  for (let j = 0; j <= n; j++) {
    const c = dp[m * width + j];
    if (c < cost) {
      cost = c;
      endJ = j;
    }
  }

  const map = new Int32Array(m).fill(-1);
  let exactMatches = 0;
  let firstMapped = -1;
  let lastMapped = -1;
  let i = m;
  let j = endJ;
  while (i > 0) {
    const src = from[i * width + j];
    if (src === 0 || src === 1) {
      const b = windowStart + j - 1;
      map[i - 1] = b;
      if (src === 0) exactMatches++;
      if (lastMapped === -1) lastMapped = b;
      firstMapped = b;
      i--;
      j--;
    } else if (src === 2) {
      i--;
    } else {
      j--;
    }
  }
  if (firstMapped === -1) return null;

  return { map, cost, exactMatches, regionStart: firstMapped, regionEnd: lastMapped + 1 };
}

function* distanceIterator(start: number, min: number, max: number): Generator<number> {
  // Yields start, start+1, start-1, start+2, start-2, ... within [min, max]
  if (start >= min && start <= max) yield start;
  for (let d = 1; ; d++) {
    const fwd = start + d;
    const back = start - d;
    const fwdOk = fwd <= max;
    const backOk = back >= min;
    if (!fwdOk && !backOk) return;
    if (fwdOk) yield fwd;
    if (backOk) yield back;
  }
}

function findExact(patternNorm: string[], baseNorm: string[], expected: number, minPos: number): number {
  const maxPos = baseNorm.length - patternNorm.length;
  if (maxPos < minPos) return -1;
  for (const pos of distanceIterator(expected, minPos, maxPos)) {
    let ok = true;
    for (let i = 0; i < patternNorm.length; i++) {
      if (baseNorm[pos + i] !== patternNorm[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return pos;
  }
  return -1;
}

function isAnchorCandidate(norm: string): boolean {
  return norm.length >= 10;
}

function buildLineIndex(baseNorm: string[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < baseNorm.length; i++) {
    const norm = baseNorm[i];
    if (!isAnchorCandidate(norm)) continue;
    let list = index.get(norm);
    if (!list) {
      list = [];
      index.set(norm, list);
    }
    list.push(i);
  }
  return index;
}

function findFuzzy(
  pattern: PatternLine[],
  patternNorm: string[],
  baseNorm: string[],
  lineIndex: Map<string, number[]>,
  expected: number,
  minPos: number,
  allowedCost: number,
): Alignment | null {
  // Vote for candidate start positions using distinctive lines of the pattern
  const votes = new Map<number, number>();
  for (let i = 0; i < patternNorm.length; i++) {
    const occurrences = lineIndex.get(patternNorm[i]);
    if (!occurrences || occurrences.length > 4) continue;
    for (const idx of occurrences) {
      const pos = idx - i;
      if (pos < minPos - allowedCost) continue;
      votes.set(pos, (votes.get(pos) ?? 0) + 1);
    }
  }
  if (!votes.has(expected)) votes.set(expected, 0);

  const candidates = Array.from(votes.entries())
    .sort((a, b) => b[1] - a[1] || Math.abs(a[0] - expected) - Math.abs(b[0] - expected))
    .slice(0, 10)
    .map(([pos]) => pos);

  const slack = allowedCost + 2;
  const requiredMatches = Math.max(1, Math.ceil(pattern.length / 2));
  const hasDistinctiveLines = patternNorm.some(isAnchorCandidate);

  let best: Alignment | null = null;
  for (const pos of candidates) {
    const windowStart = Math.max(minPos, pos - slack);
    const windowEnd = Math.min(baseNorm.length, pos + pattern.length + slack);
    if (windowEnd <= windowStart) continue;
    const alignment = alignWindow(pattern, patternNorm, baseNorm, windowStart, windowEnd);
    if (!alignment) continue;
    if (alignment.cost > allowedCost || alignment.exactMatches < requiredMatches) continue;
    if (alignment.regionStart < minPos) continue;
    // Trivial lines (braces, annotations) matching is not evidence of the right location
    if (hasDistinctiveLines && !hasDistinctiveExactMatch(alignment, patternNorm, baseNorm)) continue;
    if (
      !best ||
      alignment.cost < best.cost ||
      (alignment.cost === best.cost &&
        Math.abs(alignment.regionStart - expected) < Math.abs(best.regionStart - expected))
    ) {
      best = alignment;
    }
  }
  return best;
}

function hasDistinctiveExactMatch(alignment: Alignment, patternNorm: string[], baseNorm: string[]): boolean {
  for (let i = 0; i < patternNorm.length; i++) {
    const b = alignment.map[i];
    if (b !== -1 && isAnchorCandidate(patternNorm[i]) && baseNorm[b] === patternNorm[i]) return true;
  }
  return false;
}

function allowedCostFor(patternLength: number, maxFuzz: number): number {
  return Math.max(maxFuzz, Math.floor(patternLength / 3));
}

export function fuzzyApply(
  baseLines: string[],
  patch: UnifiedPatch,
  options: FuzzyApplyOptions = {},
): FuzzyApplyResult {
  const maxFuzz = options.maxFuzz ?? 8;
  const baseNorm = baseLines.map(normalizeLine);
  const lineIndex = buildLineIndex(baseNorm);

  const out: string[] = [];
  const results: HunkApplyResult[] = [];
  let consumed = 0; // base lines emitted or skipped so far
  let offset = 0; // running difference between header positions and actual placements
  let rejected = 0;

  for (const hunk of patch.hunks) {
    const pattern = patternOf(hunk);
    const patternNorm = pattern.map((l) => normalizeLine(l.text));
    const expected = Math.max(consumed, Math.min(baseLines.length, hunk.oldStart - 1 + offset));

    let alignment: Alignment | null;
    let status: HunkStatus = "rejected";

    if (pattern.length === 0) {
      // Pure insertion without context; place it at the expected position
      alignment = { map: new Int32Array(0), cost: 0, exactMatches: 0, regionStart: expected, regionEnd: expected };
      status = "exact";
    } else {
      const exactPos = findExact(patternNorm, baseNorm, expected, consumed);
      if (exactPos !== -1) {
        const map = new Int32Array(pattern.length);
        for (let i = 0; i < pattern.length; i++) map[i] = exactPos + i;
        alignment = {
          map,
          cost: 0,
          exactMatches: pattern.length,
          regionStart: exactPos,
          regionEnd: exactPos + pattern.length,
        };
        status = "exact";
      } else {
        const allowedCost = allowedCostFor(pattern.length, maxFuzz);
        alignment = findFuzzy(pattern, patternNorm, baseNorm, lineIndex, expected, consumed, allowedCost);
        if (alignment) status = "fuzzy";
      }
    }

    if (!alignment) {
      results.push({ status: "rejected", cost: REJECT });
      rejected++;
      continue;
    }

    // Emit untouched base lines up to the region
    while (consumed < alignment.regionStart) out.push(baseLines[consumed++]);
    const outputStart = out.length;

    let p = 0;
    for (const line of hunk.lines) {
      const marker = line.charAt(0);
      if (marker === "+") {
        out.push(line.substring(1));
        continue;
      }
      if (marker !== " " && marker !== "-") continue; // "\ No newline at end of file"
      const b = alignment.map[p];
      const removed = pattern[p].removed;
      p++;
      if (b === -1) continue; // Not present in base
      // Keep any extra base lines that precede this one
      while (consumed < b) out.push(baseLines[consumed++]);
      if (!removed) out.push(baseLines[b]);
      consumed = b + 1;
    }
    while (consumed < alignment.regionEnd) out.push(baseLines[consumed++]);

    offset = alignment.regionStart - (hunk.oldStart - 1);
    results.push({
      status,
      position: alignment.regionStart,
      offset,
      cost: alignment.cost,
      outputRange: [outputStart, out.length],
    });
  }

  while (consumed < baseLines.length) out.push(baseLines[consumed++]);
  return { lines: out, hunks: results, rejected };
}
