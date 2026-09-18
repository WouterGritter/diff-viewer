/**
 * Minimal single-file unified diff parser.
 *
 * Unlike jsdiff's `parsePatch`, this tolerates the normalized hunk headers used by
 * paperweight-style patch files (`@@ -101,6 +_,12 @@`), where the new-file start line
 * is replaced with `_` to reduce churn.
 */

export interface UnifiedHunk {
  oldStart: number;
  oldLines: number;
  /** null when the header used a `_` placeholder */
  newStart: number | null;
  newLines: number;
  /** Raw hunk lines including their leading ` `, `-`, `+` or `\` marker */
  lines: string[];
}

export interface UnifiedPatch {
  oldFileName: string | null;
  newFileName: string | null;
  hunks: UnifiedHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+|_)(?:,(\d+))? @@/;

function stripFileNamePrefix(name: string): string | null {
  name = name.trim();
  // Strip trailing timestamps ("\tYYYY-MM-DD ...")
  const tab = name.indexOf("\t");
  if (tab !== -1) name = name.substring(0, tab);
  if (name === "/dev/null") return null;
  if (name.startsWith("a/") || name.startsWith("b/")) return name.substring(2);
  return name;
}

export function parseUnifiedPatch(text: string): UnifiedPatch {
  const lines = text.split(/\r?\n/);
  const patch: UnifiedPatch = { oldFileName: null, newFileName: null, hunks: [] };

  let i = 0;
  // Preamble until the --- header
  while (i < lines.length && !lines[i].startsWith("--- ")) i++;
  if (i < lines.length) {
    patch.oldFileName = stripFileNamePrefix(lines[i].substring(4));
    i++;
    if (i < lines.length && lines[i].startsWith("+++ ")) {
      patch.newFileName = stripFileNamePrefix(lines[i].substring(4));
      i++;
    }
  }

  let current: UnifiedHunk | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: parseInt(header[1]),
        oldLines: header[2] === undefined ? 1 : parseInt(header[2]),
        newStart: header[3] === "_" ? null : parseInt(header[3]),
        newLines: header[4] === undefined ? 1 : parseInt(header[4]),
        lines: [],
      };
      patch.hunks.push(current);
      continue;
    }
    if (current === null) continue;
    if (line === "" && i === lines.length - 1) break; // trailing newline
    const marker = line.charAt(0);
    if (marker === " " || marker === "-" || marker === "+" || marker === "\\") {
      current.lines.push(line);
    } else if (line === "") {
      // Some tools emit empty context lines without the leading space
      current.lines.push(" ");
    } else {
      // Anything else ends the hunk (e.g. a git signature)
      current = null;
    }
  }

  return patch;
}

export function hunkOldLines(hunk: UnifiedHunk): string[] {
  const out: string[] = [];
  for (const line of hunk.lines) {
    const m = line.charAt(0);
    if (m === " " || m === "-") out.push(line.substring(1));
  }
  return out;
}

export function hunkNewLines(hunk: UnifiedHunk): string[] {
  const out: string[] = [];
  for (const line of hunk.lines) {
    const m = line.charAt(0);
    if (m === " " || m === "+") out.push(line.substring(1));
  }
  return out;
}
