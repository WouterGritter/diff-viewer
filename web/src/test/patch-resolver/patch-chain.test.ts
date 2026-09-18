import {
  isFeaturePatchPath,
  isSourcePatchPath,
  patchesRootOf,
  sourcePatchTarget,
  splitFeaturePatch,
} from "$lib/patch-resolver/patch-chain";
import { expect, test } from "vitest";

const FEATURE_PATCH = `From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: Someone <someone@example.com>
Date: Fri, 17 Jul 2026 16:15:46 +0200
Subject: [PATCH] Pre-load data off-main during startup


diff --git a/net/minecraft/server/Main.java b/net/minecraft/server/Main.java
index a4d608d64b7d3477c9144d93547fd3b4f39a1b02..e2939cc39a8c103e4c4d7b01d39b5546486e4fbc 100644
--- a/net/minecraft/server/Main.java
+++ b/net/minecraft/server/Main.java
@@ -102,7 +102,8 @@ public class Main {
             }
 
-            CrashReport.preload();
+            // Paper start
+            Thread.ofPlatform().start(CrashReport::preload);
             if (options.has("jfrProfile")) { // CraftBukkit
diff --git a/ca/spottedleaf/New.java b/ca/spottedleaf/New.java
new file mode 100644
index 0000000000000000000000000000000000000000..f94f8049572c860652c97c10ecd888ef2c338262
--- /dev/null
+++ b/ca/spottedleaf/New.java
@@ -0,0 +1,2 @@
+package ca.spottedleaf;
+public class New {}
-- 
2.50.0
`;

test("splits a git-format patch into per-file sections", () => {
  const sections = splitFeaturePatch(FEATURE_PATCH);
  expect([...sections.keys()]).toEqual(["net/minecraft/server/Main.java", "ca/spottedleaf/New.java"]);
  const main = sections.get("net/minecraft/server/Main.java")!;
  expect(main.startsWith("diff --git a/net/minecraft/server/Main.java")).toBe(true);
  expect(main).toContain("+            // Paper start");
  expect(main).not.toContain("ca/spottedleaf");
  const added = sections.get("ca/spottedleaf/New.java")!;
  expect(added).toContain("--- /dev/null");
  expect(added).not.toContain("2.50.0");
});

test("recognizes patch paths and their roots", () => {
  expect(isSourcePatchPath("paper-server/patches/sources/net/minecraft/server/Main.java.patch")).toBe(true);
  expect(isFeaturePatchPath("paper-server/patches/sources/net/minecraft/server/Main.java.patch")).toBe(false);
  expect(isFeaturePatchPath("paper-server/patches/features/0034-Pre-load.patch")).toBe(true);
  expect(isFeaturePatchPath("canvas-server/minecraft-patches/base/0004-Region-Threading.patch")).toBe(true);
  expect(isFeaturePatchPath("paper-server/patches/resources/data/x.json.patch")).toBe(false);
  expect(isFeaturePatchPath("paper-api/build.gradle.kts.patch")).toBe(false);
  expect(patchesRootOf("paper-server/patches/features/0034-Pre-load.patch")).toBe("paper-server/patches");
  expect(patchesRootOf("canvas-server/minecraft-patches/sources/net/a/B.java.patch")).toBe(
    "canvas-server/minecraft-patches",
  );
  expect(patchesRootOf("paper-api/build.gradle.kts.patch")).toBeNull();
  expect(sourcePatchTarget("paper-server/patches", "paper-server/patches/sources/net/minecraft/A.java.patch")).toBe(
    "net/minecraft/A.java",
  );
  expect(sourcePatchTarget("paper-server/patches", "paper-server/patches/features/0001-x.patch")).toBeNull();
});
