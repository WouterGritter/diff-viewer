import { createTwoFilesPatch } from "diff";
import { makeTextDetails, type FileDetails, type TextFileDetails } from "$lib/file-details";
import type { GithubDiff } from "$lib/github-api";
import { fetchGithubFileText } from "$lib/github-api";
import { parseUnifiedPatch, type UnifiedPatch } from "./unified-patch";
import { fuzzyApply, type FuzzyApplyResult } from "./fuzzy-apply";
import { Decompiler } from "./decompiler/client";
import { resolveJar, type JarProgress, type JarSource, type ResolvedJar } from "./jar-source";
import { isNestedJavaPatch } from "./nested-patch";

export type ResolvedFileStatus = "ok" | "partial" | "unchanged" | "failed" | "skipped";

export interface ResolvedFile {
  /** Index of the original file in the viewer */
  index: number;
  status: ResolvedFileStatus;
  /** Replacement details showing the diff of the actual patched source (absent when failed/skipped) */
  details?: TextFileDetails;
  /** Fully qualified class name (slash separated) the nested patch targets */
  className?: string;
  /** Human readable notes: rejected hunks, fuzzy placements, reasons for skipping */
  notes: string[];
}

export interface ResolveSummary {
  jarLabel: string;
  contextLines: number;
  files: ResolvedFile[];
}

export interface ResolveProgress {
  stage: "jar" | "decompiler" | "files";
  message: string;
  /** 0-1 when known */
  fraction?: number;
}

export interface ResolveOptions {
  jar: JarSource;
  /** Number of unchanged lines to show around changes in the resolved diff */
  contextLines: number;
  onProgress: (progress: ResolveProgress) => void;
  signal?: AbortSignal;
}

function nestedClassName(patch: UnifiedPatch | null): string | null {
  const name = patch?.newFileName ?? patch?.oldFileName;
  if (!name || !name.endsWith(".java")) return null;
  return name.slice(0, -".java".length);
}

function describeApply(label: string, result: FuzzyApplyResult, notes: string[]) {
  const fuzzy = result.hunks.filter((h) => h.status === "fuzzy").length;
  if (result.rejected > 0) {
    const which = result.hunks
      .map((h, i) => (h.status === "rejected" ? i + 1 : null))
      .filter((i) => i !== null)
      .join(", ");
    notes.push(`${label}: ${result.rejected} of ${result.hunks.length} hunks could not be placed (hunk ${which})`);
  }
  if (fuzzy > 0) {
    notes.push(`${label}: ${fuzzy} of ${result.hunks.length} hunks placed with fuzzy context matching`);
  }
}

type PatchTexts = { oldText: string | null; newText: string | null } | { error: string };

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Cancelled");
}

/**
 * Resolves nested patch files in a GitHub-sourced diff against the decompiled classes of a jar.
 */
export async function resolveNestedPatches(
  token: string | null,
  github: GithubDiff,
  files: FileDetails[],
  options: ResolveOptions,
): Promise<ResolveSummary> {
  const { onProgress, signal } = options;
  const candidates = files.filter(isNestedJavaPatch);
  if (candidates.length === 0) {
    throw new Error("The loaded diff does not contain any .java.patch files.");
  }

  // Fetch the full old/new contents of every nested patch file while the jar downloads
  const patchTexts = mapConcurrent(candidates, 6, async (file): Promise<PatchTexts> => {
    try {
      const oldText =
        file.status === "added"
          ? null
          : await fetchGithubFileText(token, github.owner, github.repo, file.fromFile, github.base);
      const newText =
        file.status === "removed"
          ? null
          : await fetchGithubFileText(token, github.owner, github.repo, file.toFile, github.head);
      return { oldText, newText };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });

  let jar: ResolvedJar;
  try {
    jar = await resolveJar(options.jar, (p: JarProgress) => {
      onProgress({ stage: "jar", message: p.message, fraction: p.fraction });
    });
  } catch (e) {
    throw new Error("Failed to obtain the jar to decompile", { cause: e });
  }
  throwIfAborted(signal);

  onProgress({ stage: "decompiler", message: "Starting decompiler" });
  const decompiler = await Decompiler.create(jar.bytes, jar.cacheKey);
  try {
    throwIfAborted(signal);
    const texts = await patchTexts;
    let done = 0;
    const report = () => {
      onProgress({
        stage: "files",
        message: `Decompiling and resolving patches (${done}/${candidates.length})`,
        fraction: done / candidates.length,
      });
    };
    report();

    const resolved = await mapConcurrent(candidates, 4, async (file, i) => {
      const text = texts[i];
      const result: ResolvedFile =
        "error" in text
          ? { index: file.index, status: "failed", notes: [`Could not fetch the patch file: ${text.error}`] }
          : await resolveFile(file, text.oldText, text.newText, decompiler, options.contextLines);
      done++;
      report();
      throwIfAborted(signal);
      return result;
    });

    return { jarLabel: jar.label, contextLines: options.contextLines, files: resolved };
  } finally {
    decompiler.close();
  }
}

async function resolveFile(
  file: TextFileDetails,
  oldText: string | null,
  newText: string | null,
  decompiler: Decompiler,
  contextLines: number,
): Promise<ResolvedFile> {
  const notes: string[] = [];
  const oldPatch = oldText !== null ? parseUnifiedPatch(oldText) : null;
  const newPatch = newText !== null ? parseUnifiedPatch(newText) : null;
  const className = nestedClassName(newPatch) ?? nestedClassName(oldPatch);
  if (!className) {
    return { index: file.index, status: "skipped", notes: ["Not a unified diff of a .java file"] };
  }

  let baseSource: string;
  try {
    baseSource = await decompiler.decompile(className);
  } catch (e) {
    return {
      index: file.index,
      status: "skipped",
      className,
      notes: [`Could not decompile ${className}: ${e instanceof Error ? e.message : String(e)}`],
    };
  }
  const baseLines = baseSource.split("\n");

  let oldLines = baseLines;
  let newLines = baseLines;
  let status: ResolvedFileStatus = "ok";
  if (oldPatch) {
    const result = fuzzyApply(baseLines, oldPatch);
    describeApply("Old patch", result, notes);
    if (result.rejected > 0) status = "partial";
    oldLines = result.lines;
  }
  if (newPatch) {
    const result = fuzzyApply(baseLines, newPatch);
    describeApply("New patch", result, notes);
    if (result.rejected > 0) status = "partial";
    newLines = result.lines;
  }

  const nestedPath = `${className}.java`;
  const oldSource = oldLines.join("\n");
  const newSource = newLines.join("\n");
  if (oldSource === newSource) {
    status = "unchanged";
    notes.push("The change to the patch file does not alter the resulting source");
  }
  const patchText = createTwoFilesPatch(nestedPath, nestedPath, oldSource, newSource, undefined, undefined, {
    context: contextLines,
  });
  const details = makeTextDetails(file.fromFile, file.toFile, file.status, patchText);
  details.index = file.index;
  return { index: file.index, status, details, className, notes };
}
