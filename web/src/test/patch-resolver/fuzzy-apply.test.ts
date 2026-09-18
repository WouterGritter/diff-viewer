import { fuzzyApply } from "$lib/patch-resolver/fuzzy-apply";
import { parseUnifiedPatch } from "$lib/patch-resolver/unified-patch";
import { expect, test } from "vitest";

const BASE = `class Foo {
    @Override
    public void tick() {
        if (ready) {
            level.setBlock(pos, state, 2);
        }
    }

    private int helper(int a) {
        return a + 1;
    }
}`;

const PATCH = `--- a/Foo.java
+++ b/Foo.java
@@ -2,6 +_,10 @@
     @Override
     public void tick() {
         if (ready) {
+            // Paper start
+            if (cancelled()) {
+                return;
+            }
+            // Paper end
             level.setBlock(pos, state, Block.UPDATE_CLIENTS);
         }
     }
@@ -9,3 +_,3 @@
     private int helper(int a) {
-        return a + 1;
+        return a + 2; // Paper
     }
`;

test("applies hunks exactly when context matches", () => {
  const base = BASE.replace("2);", "Block.UPDATE_CLIENTS);").split("\n");
  const result = fuzzyApply(base, parseUnifiedPatch(PATCH));
  expect(result.rejected).toBe(0);
  expect(result.hunks.map((h) => h.status)).toEqual(["exact", "exact"]);
  expect(result.lines.join("\n")).toContain("// Paper start\n            if (cancelled()) {");
  expect(result.lines.join("\n")).toContain("return a + 2; // Paper");
  expect(result.lines.join("\n")).not.toContain("return a + 1;");
});

test("places hunks fuzzily when context differs slightly and keeps base context lines", () => {
  const result = fuzzyApply(BASE.split("\n"), parseUnifiedPatch(PATCH));
  expect(result.rejected).toBe(0);
  expect(result.hunks[0].status).toBe("fuzzy");
  expect(result.hunks[1].status).toBe("exact");
  const text = result.lines.join("\n");
  // Context is taken from the base, not the patch
  expect(text).toContain("level.setBlock(pos, state, 2);");
  expect(text).toContain("// Paper end\n            level.setBlock(pos, state, 2);");
});

test("tolerates an extra line in the base inside the hunk context", () => {
  const base = BASE.replace("        if (ready) {", "        // extra comment\n        if (ready) {").split("\n");
  const result = fuzzyApply(base, parseUnifiedPatch(PATCH));
  expect(result.rejected).toBe(0);
  const text = result.lines.join("\n");
  expect(text).toContain("// extra comment");
  expect(text).toContain("// Paper start");
});

test("rejects hunks whose context cannot be found and continues with later hunks", () => {
  const base = BASE.replace("public void tick()", "public void somethingElse()")
    .replace("if (ready) {", "while (true) {")
    .replace("level.setBlock(pos, state, 2);", "doStuff();")
    .split("\n");
  const result = fuzzyApply(base, parseUnifiedPatch(PATCH));
  expect(result.rejected).toBe(1);
  expect(result.hunks[0].status).toBe("rejected");
  expect(result.hunks[1].status).toBe("exact");
  expect(result.lines.join("\n")).toContain("return a + 2; // Paper");
});

test("applying two variants of a patch to the same base only differs where the patches differ", () => {
  const variant = PATCH.replace("return a + 2; // Paper", "return a + 3; // Paper");
  const a = fuzzyApply(BASE.split("\n"), parseUnifiedPatch(PATCH)).lines;
  const b = fuzzyApply(BASE.split("\n"), parseUnifiedPatch(variant)).lines;
  expect(a.length).toBe(b.length);
  const differing = a.filter((line, i) => line !== b[i]);
  expect(differing).toEqual(["        return a + 2; // Paper"]);
});
