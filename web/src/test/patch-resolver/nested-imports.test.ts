import { normalizeNestedImports } from "$lib/patch-resolver/nested-imports";
import { expect, test } from "vitest";

const JAR = new Set([
  "net/minecraft/core/Holder",
  "net/minecraft/core/Holder$Reference",
  "net/minecraft/core/Direction",
  "net/minecraft/core/Direction$Axis",
  "net/minecraft/world/level/block/Block",
  "net/minecraft/world/level/block/Outer",
  "net/minecraft/world/level/block/Outer$Inner",
]);
const isJarClass = (name: string) => JAR.has(name);

test("rewrites direct nested imports to outer-class imports", () => {
  const source = `package net.minecraft.world.level.block;

import java.util.List;
import net.minecraft.core.Direction.Axis;
import net.minecraft.core.Holder.Reference;
import net.minecraft.world.level.block.Outer.Inner;

public class Block {
    private final Reference<Block> holder = null;
    private final Inner inner = new Inner("Reference");
    Axis axis = Axis.Y; // Axis
}
`;
  const expected = `package net.minecraft.world.level.block;

import java.util.List;
import net.minecraft.core.Direction;
import net.minecraft.core.Holder;

public class Block {
    private final Holder.Reference<Block> holder = null;
    private final Outer.Inner inner = new Outer.Inner("Reference");
    Direction.Axis axis = Direction.Axis.Y; // Axis
}
`;
  expect(normalizeNestedImports(source, isJarClass)).toBe(expected);
});

test("leaves sources without nested imports untouched", () => {
  const source = "package a;\n\nimport java.util.List;\n\npublic class A {}\n";
  expect(normalizeNestedImports(source, isJarClass)).toBe(source);
});
