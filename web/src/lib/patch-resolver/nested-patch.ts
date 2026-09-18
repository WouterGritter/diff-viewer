import type { FileDetails, TextFileDetails } from "$lib/file-details";

/**
 * Whether a file in the loaded diff is a "patch of a patch": a unified diff stored in the
 * repository (e.g. `paper-server/patches/sources/net/minecraft/…/Foo.java.patch`) that could be
 * resolved against the source it targets.
 */
export function isNestedJavaPatch(file: FileDetails): file is TextFileDetails {
  return file.type === "text" && (file.toFile.endsWith(".java.patch") || file.fromFile.endsWith(".java.patch"));
}
