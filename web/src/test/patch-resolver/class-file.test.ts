import { makeStubClass, parseClassFile } from "$lib/patch-resolver/class-file";
import { expect, test } from "vitest";

test("stub class round-trips through the parser", () => {
  const refs = ["net/minecraft/world/entity/Entity", "net/minecraft/core/BlockPos$MutableBlockPos"];
  const info = parseClassFile(makeStubClass("$stub", refs));
  expect(info.name).toBe("$stub");
  expect(info.superName).toBe("java/lang/Object");
  expect(info.interfaces).toEqual([]);
  for (const ref of refs) expect(info.references.has(ref)).toBe(true);
});
