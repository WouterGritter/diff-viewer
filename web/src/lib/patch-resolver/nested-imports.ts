/**
 * Vineflower imports nested classes of *library* classes directly (`import a.b.Outer.Inner;`
 * and `Inner` in code), but for classes it decompiles as part of the same input it imports the
 * top-level class and qualifies uses (`import a.b.Outer;` and `Outer.Inner`). Projects like
 * Paper decompile the whole jar at once, so their patches expect the latter style. This rewrites
 * the former into the latter for nested classes contained in the jar.
 *
 * @param source decompiled Java source
 * @param isJarClass whether a slash separated, `$` nested class name exists in the jar
 */
export function normalizeNestedImports(source: string, isJarClass: (name: string) => boolean): string {
  const packageMatch = /^package\s+([\w.]+)\s*;/m.exec(source);
  const ownPackage = packageMatch ? packageMatch[1] : "";

  const importRegex = /^import\s+([\w.]+)\s*;\r?\n/gm;
  const rewrites: { simpleName: string; qualified: string }[] = [];
  const addImports = new Set<string>();
  const removeImports = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    const dotted = match[1];
    const parts = dotted.split(".");
    // Find the shortest prefix that is a top-level class in the jar with the rest nested in it
    for (let i = 1; i < parts.length - 1; i++) {
      const outer = parts.slice(0, i + 1).join("/");
      const nested = outer + "$" + parts.slice(i + 1).join("$");
      if (isJarClass(outer) && isJarClass(nested)) {
        const outerDotted = parts.slice(0, i + 1).join(".");
        const outerPackage = parts.slice(0, i).join(".");
        rewrites.push({ simpleName: parts[parts.length - 1], qualified: parts.slice(i).join(".") });
        removeImports.add(dotted);
        if (outerPackage !== ownPackage) addImports.add(outerDotted);
        break;
      }
    }
  }
  if (rewrites.length === 0) return source;

  const lines = source.split("\n");
  const out: string[] = [];
  let importsDone = false;
  const existingImports = new Set<string>();
  for (const line of lines) {
    const im = /^import\s+([\w.]+)\s*;/.exec(line);
    if (im) existingImports.add(im[1]);
  }
  for (const line of lines) {
    const im = /^import\s+([\w.]+)\s*;/.exec(line);
    if (im) {
      if (removeImports.has(im[1])) continue;
      out.push(line);
      continue;
    }
    if (!importsDone && out.some((l) => l.startsWith("import ")) && line.trim() !== "" && !line.startsWith("import")) {
      // End of the import block: insert the new imports (sorted with the existing ones)
      importsDone = true;
      const toAdd = Array.from(addImports).filter((i) => !existingImports.has(i));
      if (toAdd.length > 0) {
        // Pull the contiguous import block (and blank lines within it) back out of the output
        let start = out.length;
        while (start > 0 && (out[start - 1].startsWith("import ") || out[start - 1].trim() === "")) start--;
        while (start < out.length && !out[start].startsWith("import ")) start++;
        const block = out.splice(start);
        const trailingBlank = block.length > 0 && block[block.length - 1].trim() === "" ? block.pop() : undefined;
        const imports = block.filter((l) => l.startsWith("import "));
        for (const add of toAdd) imports.push(`import ${add};`);
        imports.sort((a, b) => compareImports(a, b));
        out.push(...imports);
        if (trailingBlank !== undefined) out.push(trailingBlank);
      }
    }
    out.push(importsDone ? rewriteIdentifiers(line, rewrites) : line);
  }
  return out.join("\n");
}

function compareImports(a: string, b: string): number {
  // Vineflower emits imports in plain lexicographic order of the qualified name
  const na = a.replace(/^import\s+|;$/g, "");
  const nb = b.replace(/^import\s+|;$/g, "");
  return na < nb ? -1 : na > nb ? 1 : 0;
}

const IDENT = /[A-Za-z0-9_$]/;

/** Replaces bare identifier uses outside of string/char literals */
function rewriteIdentifiers(line: string, rewrites: { simpleName: string; qualified: string }[]): string {
  let result = "";
  let i = 0;
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === '"' || c === "'") {
      // Copy the literal verbatim
      let j = i + 1;
      while (j < line.length && line.charAt(j) !== c) {
        if (line.charAt(j) === "\\") j++;
        j++;
      }
      result += line.substring(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "/" && line.charAt(i + 1) === "/") {
      result += line.substring(i);
      break;
    }
    if (IDENT.test(c)) {
      let j = i;
      while (j < line.length && IDENT.test(line.charAt(j))) j++;
      const word = line.substring(i, j);
      const precededByDot = i > 0 && line.charAt(i - 1) === ".";
      let replaced = false;
      if (!precededByDot) {
        for (const rewrite of rewrites) {
          if (rewrite.simpleName === word) {
            result += rewrite.qualified;
            replaced = true;
            break;
          }
        }
      }
      if (!replaced) result += word;
      i = j;
      continue;
    }
    result += c;
    i++;
  }
  return result;
}
