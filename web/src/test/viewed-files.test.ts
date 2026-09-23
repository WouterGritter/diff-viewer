import { expect, test } from "vitest";
import { binaryFileDummyDetails, makeTextDetails } from "$lib/file-details";
import {
  pruneViewedEntries,
  VIEWED_FILES_MAX_AGE_MS,
  VIEWED_FILES_MAX_ENTRIES,
  viewedKey,
} from "$lib/viewed-files.svelte";

const PATCH = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
`;

test("viewed key ignores headers and line numbers", () => {
  const key = viewedKey(makeTextDetails("a.txt", "a.txt", "modified", PATCH));
  expect(key).toBeDefined();
  const otherSource = PATCH.replace("index 1111111..2222222 100644\n", "").replace(
    "@@ -1,3 +1,3 @@",
    "@@ -11,3 +11,3 @@",
  );
  expect(viewedKey(makeTextDetails("a.txt", "a.txt", "modified", otherSource))).toBe(key);
});

test("viewed key depends on content and paths", () => {
  const key = viewedKey(makeTextDetails("a.txt", "a.txt", "modified", PATCH));
  expect(viewedKey(makeTextDetails("a.txt", "a.txt", "modified", PATCH.replace("+TWO", "+Two")))).not.toBe(key);
  const renamed = PATCH.replaceAll("b/a.txt", "b/b.txt");
  expect(viewedKey(makeTextDetails("a.txt", "b.txt", "renamed_modified", renamed))).not.toBe(key);
});

test("binary files have no viewed key", () => {
  expect(viewedKey(binaryFileDummyDetails("a.bin", "a.bin", "modified"))).toBeUndefined();
});

test("pruning drops expired and oldest entries", () => {
  const now = 1_000_000_000_000;
  expect(pruneViewedEntries({ old: now - VIEWED_FILES_MAX_AGE_MS, fresh: now - 1 }, now)).toEqual({ fresh: now - 1 });

  const entries: Record<string, number> = {};
  for (let i = 0; i <= VIEWED_FILES_MAX_ENTRIES; i++) entries["k" + i] = now - VIEWED_FILES_MAX_ENTRIES + i;
  const pruned = pruneViewedEntries(entries, now);
  expect(Object.keys(pruned).length).toBe(VIEWED_FILES_MAX_ENTRIES);
  expect("k0" in pruned).toBe(false);
});
