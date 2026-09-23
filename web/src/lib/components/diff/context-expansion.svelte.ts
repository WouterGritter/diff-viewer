import type { StructuredPatch, StructuredPatchHunk } from "diff";
import { SvelteMap, SvelteSet } from "svelte/reactivity";
import type { FullFileSide, TextFileDetails } from "$lib/file-details";
import { isNoNewlineAtEofLine } from "$lib/components/diff/text-diff.svelte";
import { formatErrorWithCauses } from "$lib/util";

/** Number of hidden lines revealed per click, same as GitHub */
export const EXPAND_STEP = 20;

/**
 * - up: reveal the lines directly above the following hunk
 * - down: reveal the lines directly below the preceding hunk
 * - all: reveal the whole gap
 */
export type ExpandDirection = "up" | "down" | "all";

export interface FullFileContent {
  lines: string[];
  noEofNewline: boolean;
}

export function splitFullFile(text: string): FullFileContent {
  const lines = text.split("\n");
  const eofNewline = text.endsWith("\n");
  if (eofNewline || text === "") {
    lines.pop();
  }
  return { lines, noEofNewline: !eofNewline && text !== "" };
}

function sideStart(hunk: StructuredPatchHunk, side: FullFileSide): number {
  return side === "new" ? hunk.newStart : hunk.oldStart;
}

/** First line number after the hunk. Starts of empty sides are already adjusted by parsePatch. */
function sideEnd(hunk: StructuredPatchHunk, side: FullFileSide): number {
  return side === "new" ? hunk.newStart + hunk.newLines : hunk.oldStart + hunk.oldLines;
}

/** A missing trailing newline on either side means the hunk reaches the end of both files */
function endsAtEof(hunk: StructuredPatchHunk): boolean {
  return hunk.lines.some(isNoNewlineAtEofLine);
}

/**
 * Sizes of the unchanged regions hidden around the hunks: index i is the gap before hunk i,
 * index hunks.length the gap after the last hunk (null when the file length is not known yet).
 */
export function gapSizes(patch: StructuredPatch, side: FullFileSide, lineCount: number | null): (number | null)[] {
  const hunks = patch.hunks;
  const sizes: (number | null)[] = [];
  for (let i = 0; i < hunks.length; i++) {
    const prevEnd = i === 0 ? 1 : sideEnd(hunks[i - 1], side);
    sizes.push(Math.max(0, sideStart(hunks[i], side) - prevEnd));
  }
  const last = hunks[hunks.length - 1];
  if (lineCount !== null) {
    sizes.push(Math.max(0, lineCount + 1 - sideEnd(last, side)));
  } else {
    sizes.push(endsAtEof(last) ? 0 : null);
  }
  return sizes;
}

/** Checks that the unchanged and given-side lines of the patch agree with the full file */
export function matchesPatch(patch: StructuredPatch, side: FullFileSide, content: FullFileContent): boolean {
  const sideOp = side === "new" ? "+" : "-";
  for (const hunk of patch.hunks) {
    let lineNo = sideStart(hunk, side);
    for (const line of hunk.lines) {
      if (isNoNewlineAtEofLine(line)) continue;
      const op = line.length === 0 ? " " : line[0];
      if (op !== " " && op !== sideOp) continue;
      if (content.lines[lineNo - 1] !== line.substring(1)) return false;
      lineNo++;
    }
  }
  return true;
}

function contextLines(content: FullFileContent, from: number, to: number): string[] {
  const lines: string[] = [];
  for (let no = from; no <= to; no++) {
    lines.push(" " + content.lines[no - 1]);
  }
  if (to === content.lines.length && content.noEofNewline && lines.length > 0) {
    lines.push("\\ No newline at end of file");
  }
  return lines;
}

/** Returns a copy of the patch with (part of) the given gap turned into context lines */
export function expandPatch(
  patch: StructuredPatch,
  content: FullFileContent,
  side: FullFileSide,
  gapIdx: number,
  direction: ExpandDirection,
): StructuredPatch {
  const hunks = [...patch.hunks];
  const prev = gapIdx > 0 ? hunks[gapIdx - 1] : undefined;
  const next = gapIdx < hunks.length ? hunks[gapIdx] : undefined;
  const from = prev ? sideEnd(prev, side) : 1;
  const to = next ? sideStart(next, side) - 1 : content.lines.length;
  const size = to - from + 1;
  if (size <= 0 || (!prev && !next)) {
    return patch;
  }

  const count = direction === "all" ? size : Math.min(EXPAND_STEP, size);
  // Without a hunk on one side, the gap can only grow from the other
  if (!prev) direction = "up";
  else if (!next) direction = "down";

  if (prev && next && count === size) {
    // The gap closes, merge the surrounding hunks
    hunks.splice(gapIdx - 1, 2, {
      oldStart: prev.oldStart,
      oldLines: prev.oldLines + size + next.oldLines,
      newStart: prev.newStart,
      newLines: prev.newLines + size + next.newLines,
      lines: [...prev.lines, ...contextLines(content, from, to), ...next.lines],
    });
  } else if (direction === "down") {
    hunks[gapIdx - 1] = {
      ...prev!,
      oldLines: prev!.oldLines + count,
      newLines: prev!.newLines + count,
      lines: [...prev!.lines, ...contextLines(content, from, from + count - 1)],
    };
  } else {
    hunks[gapIdx] = {
      oldStart: next!.oldStart - count,
      oldLines: next!.oldLines + count,
      newStart: next!.newStart - count,
      newLines: next!.newLines + count,
      lines: [...contextLines(content, to - count + 1, to), ...next!.lines],
    };
  }
  return { ...patch, hunks };
}

/**
 * Expansion of the unchanged lines hidden between the hunks of text diffs, for files whose full
 * contents can be loaded (see {@link TextFileDetails.fullFile}).
 */
export class ContextExpansionState {
  /** Expanded patches, replacing the file's own patch */
  private readonly patches = new SvelteMap<TextFileDetails, StructuredPatch>();
  /** Loaded full contents, null when they do not match the diff */
  private readonly contents = new SvelteMap<TextFileDetails, FullFileContent | null>();
  private readonly pending = new Map<TextFileDetails, Promise<FullFileContent | null>>();
  private readonly loading = new SvelteSet<TextFileDetails>();

  /** The patch to show for a file, including any expanded context */
  getPatch(file: TextFileDetails): StructuredPatch {
    return this.patches.get(file) ?? file.structuredPatch;
  }

  /** Hidden line counts around the hunks of the given (displayed) patch, null when it cannot be expanded */
  gaps(file: TextFileDetails, patch: StructuredPatch): (number | null)[] | null {
    const source = file.fullFile;
    if (!source || patch.hunks.length === 0) return null;
    const content = this.contents.get(file);
    if (content === null) return null;
    return gapSizes(patch, source.side, content ? content.lines.length : null);
  }

  isLoading(file: TextFileDetails): boolean {
    return this.loading.has(file);
  }

  /**
   * Reveals hidden lines of a gap in the displayed patch. Ignored when the displayed patch has
   * changed in the meantime, since gap indices refer to it.
   */
  async expand(file: TextFileDetails, patch: StructuredPatch, gapIdx: number, direction: ExpandDirection) {
    const content = await this.load(file);
    if (!content || this.getPatch(file) !== patch) return;
    this.patches.set(file, expandPatch(patch, content, file.fullFile!.side, gapIdx, direction));
  }

  private load(file: TextFileDetails): Promise<FullFileContent | null> {
    const loaded = this.contents.get(file);
    if (loaded !== undefined) return Promise.resolve(loaded);
    let pending = this.pending.get(file);
    if (!pending) {
      pending = this.fetch(file);
      this.pending.set(file, pending);
    }
    return pending;
  }

  private async fetch(file: TextFileDetails): Promise<FullFileContent | null> {
    const source = file.fullFile;
    if (!source) return null;
    this.loading.add(file);
    try {
      const content = splitFullFile(await source.load());
      if (!matchesPatch(file.structuredPatch, source.side, content)) {
        console.warn(`Full contents of ${file.toFile} do not match the diff, context cannot be expanded`);
        alert(`The contents of ${file.toFile} do not match the diff, so its context cannot be expanded.`);
        this.contents.set(file, null);
        return null;
      }
      this.contents.set(file, content);
      return content;
    } catch (e) {
      // Not remembered, the next click retries
      console.error(`Failed to load the contents of ${file.toFile}:`, e);
      alert(formatErrorWithCauses(e));
      return null;
    } finally {
      this.pending.delete(file);
      this.loading.delete(file);
    }
  }

  clear() {
    this.patches.clear();
    this.contents.clear();
    this.pending.clear();
    this.loading.clear();
  }
}
