import { applyPatch, createTwoFilesPatch, parsePatch } from "diff";
import { expect, test } from "vitest";
import {
  EXPAND_STEP,
  expandPatch,
  gapSizes,
  matchesPatch,
  splitFullFile,
} from "$lib/components/diff/context-expansion.svelte";

function lines(count: number, prefix = "line"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`);
}

function patchOf(oldText: string, newText: string, context = 3) {
  return parsePatch(createTwoFilesPatch("a", "b", oldText, newText, undefined, undefined, { context }))[0];
}

const OLD = lines(100).join("\n") + "\n";
const NEW_LINES = lines(100);
NEW_LINES[29] = "changed 30";
NEW_LINES[69] = "changed 70";
const NEW = NEW_LINES.join("\n") + "\n";

test("gap sizes around hunks", () => {
  const patch = patchOf(OLD, NEW);
  const content = splitFullFile(NEW);
  expect(content.lines.length).toBe(100);
  expect(matchesPatch(patch, "new", content)).toBe(true);
  // Hunks cover 27-33 and 67-73
  expect(gapSizes(patch, "new", 100)).toEqual([26, 33, 27]);
  // Unknown file length leaves the trailing gap unknown
  expect(gapSizes(patch, "new", null)).toEqual([26, 33, null]);
});

test("expanding up, down and merging", () => {
  const content = splitFullFile(NEW);
  let patch = patchOf(OLD, NEW);

  patch = expandPatch(patch, content, "new", 1, "down");
  expect(gapSizes(patch, "new", 100)).toEqual([26, 33 - EXPAND_STEP, 27]);
  patch = expandPatch(patch, content, "new", 1, "up");
  expect(patch.hunks.length).toBe(1);
  expect(gapSizes(patch, "new", 100)).toEqual([26, 27]);
  expect(applyPatch(OLD, patch)).toBe(NEW);

  patch = expandPatch(patch, content, "new", 0, "up");
  expect(gapSizes(patch, "new", 100)).toEqual([6, 27]);
  expect(patch.hunks[0].newStart).toBe(7);
  patch = expandPatch(patch, content, "new", 1, "all");
  expect(gapSizes(patch, "new", 100)).toEqual([6, 0]);
  expect(applyPatch(OLD, patch)).toBe(NEW);
});

test("rejects contents that do not match the diff", () => {
  const patch = patchOf(OLD, NEW);
  expect(matchesPatch(patch, "new", splitFullFile(OLD))).toBe(false);
});

test("random expansions keep the patch valid", () => {
  let seed = 42;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let iter = 0; iter < 500; iter++) {
    const oldLines = lines(1 + rnd(120));
    const newLines = [...oldLines];
    for (let e = 0; e < 1 + rnd(5); e++) {
      const pos = rnd(newLines.length + 1);
      const kind = rnd(3);
      if (kind === 0) newLines.splice(pos, 0, `added ${e}`);
      else if (kind === 1 && newLines.length > 1) newLines.splice(Math.min(pos, newLines.length - 1), 1);
      else newLines[Math.min(pos, newLines.length - 1)] = `changed ${e}`;
    }
    const oldText = oldLines.join("\n") + (rnd(4) ? "\n" : "");
    const newText = newLines.join("\n") + (rnd(4) ? "\n" : "");
    if (oldText === newText) continue;

    const side = rnd(2) ? "new" : "old";
    const content = splitFullFile(side === "new" ? newText : oldText);
    let patch = patchOf(oldText, newText, rnd(4));
    expect(matchesPatch(patch, side, content)).toBe(true);
    for (let step = 0; step < 40; step++) {
      const open = gapSizes(patch, side, content.lines.length)
        .map((size, i) => [size!, i])
        .filter(([size]) => size > 0);
      if (open.length === 0) {
        expect(patch.hunks.length).toBe(1);
        break;
      }
      const [, gapIdx] = open[rnd(open.length)];
      patch = expandPatch(patch, content, side, gapIdx, (["up", "down", "all"] as const)[rnd(3)]);
      expect(applyPatch(oldText, patch)).toBe(newText);
      expect(matchesPatch(patch, side, content)).toBe(true);
    }
  }
});
