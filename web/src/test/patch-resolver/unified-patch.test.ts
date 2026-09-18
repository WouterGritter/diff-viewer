import { hunkNewLines, hunkOldLines, parseUnifiedPatch } from "$lib/patch-resolver/unified-patch";
import { expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

export function loadFixture(name: string): string {
  return fs.readFileSync(path.resolve(__dirname, name), "utf8");
}

test("parses paperweight-style patch with '_' new-start placeholders", () => {
  const patch = parseUnifiedPatch(loadFixture("RemoveBlockGoal.java.patch"));
  expect(patch.oldFileName).toBe("net/minecraft/world/entity/ai/goal/RemoveBlockGoal.java");
  expect(patch.newFileName).toBe("net/minecraft/world/entity/ai/goal/RemoveBlockGoal.java");
  expect(patch.hunks).toHaveLength(3);
  expect(patch.hunks[0].oldStart).toBe(101);
  expect(patch.hunks[0].oldLines).toBe(6);
  expect(patch.hunks[0].newStart).toBeNull();
  expect(patch.hunks[0].newLines).toBe(12);
  expect(hunkOldLines(patch.hunks[0])).toHaveLength(6);
  expect(hunkNewLines(patch.hunks[0])).toHaveLength(12);
});

test("parses regular hunk headers and /dev/null", () => {
  const patch = parseUnifiedPatch("--- /dev/null\n+++ b/Foo.java\n@@ -0,0 +1,2 @@\n+a\n+b\n");
  expect(patch.oldFileName).toBeNull();
  expect(patch.newFileName).toBe("Foo.java");
  expect(patch.hunks[0].newStart).toBe(1);
  expect(patch.hunks[0].lines).toEqual(["+a", "+b"]);
});
