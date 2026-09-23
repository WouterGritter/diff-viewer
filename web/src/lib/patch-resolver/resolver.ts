import { createTwoFilesPatch } from "diff";
import { makeTextDetails, type FileDetails, type FileStatus, type TextFileDetails } from "$lib/file-details";
import type { GithubDiff } from "$lib/github-api";
import { fetchGithubFileText } from "$lib/github-api";
import { parseUnifiedPatch } from "./unified-patch";
import { fuzzyApply } from "./fuzzy-apply";
import { Decompiler } from "./decompiler/client";
import { resolveJar, type JarProgress, type JarSource } from "./jar-source";
import {
  changedFeatureTargets,
  isFeaturePatchPath,
  isResolvablePatch,
  isSourcePatchPath,
  PatchChainBuilder,
  patchesRootOf,
  sourcePatchTarget,
  type ChainStep,
  type OuterPatchChange,
} from "./patch-chain";

export type ResolvedStatus = "ok" | "partial" | "unchanged" | "failed" | "skipped";

/** One resolved target file (a class) of a patch file in the viewed diff */
export interface ResolvedEntry {
  /** Index in the viewer; equals the outer file's index when it replaces it one-to-one, assigned later otherwise */
  index: number;
  outerIndex: number;
  /** Path of the target inside the patched source tree, e.g. net/minecraft/server/Main.java */
  target: string;
  status: ResolvedStatus;
  notes: string[];
  details?: TextFileDetails;
}

/** Resolution result for one patch file in the viewed diff */
export interface ResolvedFile {
  index: number;
  status: ResolvedStatus;
  notes: string[];
  entries: ResolvedEntry[];
}

export interface ResolveSummary {
  jarLabel: string;
  /** Labels of the patch layers that were applied, upstream first */
  layers: string[];
  files: ResolvedFile[];
}

export interface ResolveProgress {
  stage: "jar" | "patches" | "decompiler" | "files";
  message: string;
  /** 0-1 when known */
  fraction?: number;
}

export interface ResolveOptions {
  jar: JarSource;
  onProgress: (progress: ResolveProgress) => void;
  signal?: AbortSignal;
}

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

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Resolves patch files in a GitHub-sourced diff against the source they target: the classes of a
 * jar, decompiled in the browser, with all patches of the repository (and its upstream) that
 * precede or follow the changed patch applied on top.
 */
export async function resolveNestedPatches(
  token: string | null,
  github: GithubDiff,
  files: FileDetails[],
  options: ResolveOptions,
): Promise<ResolveSummary> {
  const { onProgress, signal } = options;
  const candidates = files.filter(isResolvablePatch) as TextFileDetails[];
  if (candidates.length === 0) {
    throw new Error("The loaded diff does not contain any resolvable patch files.");
  }

  // Start the (large) jar download right away, everything else happens in the meantime
  const jarPromise = resolveJar(options.jar, (p: JarProgress) => {
    onProgress({ stage: "jar", message: p.message, fraction: p.fraction });
  }).catch((e) => {
    throw new Error("Failed to obtain the jar to decompile", { cause: e });
  });
  jarPromise.catch(() => {}); // handled below

  // Old and new contents of the changed patch files
  const changes = new Map<string, OuterPatchChange>();
  const fetchErrors = new Map<number, string>();
  await mapConcurrent(candidates, 6, async (file) => {
    try {
      const oldText =
        file.status === "added"
          ? null
          : await fetchGithubFileText(token, github.owner, github.repo, file.fromFile, github.base);
      const newText =
        file.status === "removed"
          ? null
          : await fetchGithubFileText(token, github.owner, github.repo, file.toFile, github.head);
      changes.set(file.toFile, { oldText, newText });
      if (file.fromFile !== file.toFile) changes.set(file.fromFile, { oldText, newText: null });
    } catch (e) {
      fetchErrors.set(file.index, errorMessage(e));
    }
  });
  throwIfAborted(signal);

  const root = candidates.map((f) => patchesRootOf(f.toFile)).find((r) => r !== null) ?? null;
  if (root === null) {
    throw new Error("Could not determine the patches directory of the repository.");
  }
  onProgress({ stage: "patches", message: "Discovering patch layers" });
  const layers = await PatchChainBuilder.discoverLayers(token, github, root);
  const chain = new PatchChainBuilder(token, layers, changes, (message) => {
    onProgress({ stage: "patches", message });
  });
  await Promise.all(layers.map((layer) => chain.featurePatches(layer)));
  throwIfAborted(signal);

  const jar = await jarPromise;
  throwIfAborted(signal);
  onProgress({ stage: "decompiler", message: "Starting decompiler" });
  const decompiler = await Decompiler.create(jar.bytes, jar.cacheKey);
  try {
    throwIfAborted(signal);
    let done = 0;
    const report = () => {
      onProgress({
        stage: "files",
        message: `Decompiling and resolving patches (${done}/${candidates.length})`,
        fraction: done / candidates.length,
      });
    };
    report();

    const resolved = await mapConcurrent(candidates, 4, async (file) => {
      const fetchError = fetchErrors.get(file.index);
      const result: ResolvedFile = fetchError
        ? { index: file.index, status: "failed", notes: [`Could not fetch the patch file: ${fetchError}`], entries: [] }
        : await resolveOuterFile(file, root, changes, chain, decompiler);
      done++;
      report();
      throwIfAborted(signal);
      return result;
    });

    return {
      jarLabel: jar.label,
      layers: layers.map((l) => l.label),
      files: resolved,
    };
  } finally {
    decompiler.close();
  }
}

async function resolveOuterFile(
  file: TextFileDetails,
  root: string,
  changes: Map<string, OuterPatchChange>,
  chain: PatchChainBuilder,
  decompiler: Decompiler,
): Promise<ResolvedFile> {
  const path = file.toFile || file.fromFile;
  const change = changes.get(file.toFile) ?? changes.get(file.fromFile);
  if (!change) {
    return { index: file.index, status: "failed", notes: ["Patch contents unavailable"], entries: [] };
  }
  if (patchesRootOf(path) !== root) {
    return {
      index: file.index,
      status: "skipped",
      notes: ["Patch is outside the detected patches directory"],
      entries: [],
    };
  }

  let targets: { target: string; oneToOne: boolean }[];
  if (isSourcePatchPath(path)) {
    const target = sourcePatchTarget(root, path);
    if (!target) {
      return { index: file.index, status: "skipped", notes: ["Not a sources patch"], entries: [] };
    }
    targets = [{ target, oneToOne: true }];
  } else if (isFeaturePatchPath(path)) {
    targets = changedFeatureTargets(change).map((target) => ({ target, oneToOne: false }));
    if (targets.length === 0) {
      return {
        index: file.index,
        status: "unchanged",
        notes: ["The change does not alter any of the patch's file sections"],
        entries: [],
      };
    }
  } else {
    return { index: file.index, status: "skipped", notes: ["Unrecognized patch file"], entries: [] };
  }

  const entries = await mapConcurrent(targets, 2, async ({ target, oneToOne }) => {
    const entry = await resolveTarget(file, target, chain, decompiler);
    entry.index = oneToOne ? file.index : -1;
    if (entry.details) entry.details.index = entry.index;
    return entry;
  });

  const notes: string[] = [];
  let status: ResolvedStatus = "ok";
  if (entries.every((e) => e.status === "skipped" || e.status === "failed")) status = "skipped";
  else if (entries.some((e) => e.status === "partial")) status = "partial";
  else if (entries.every((e) => e.status === "unchanged")) status = "unchanged";
  if (targets.length > 1) notes.push(`${targets.length} files changed by this patch`);
  return { index: file.index, status, notes, entries };
}

async function resolveTarget(
  file: TextFileDetails,
  target: string,
  chain: PatchChainBuilder,
  decompiler: Decompiler,
): Promise<ResolvedEntry> {
  const notes: string[] = [];
  const base = (): ResolvedEntry => ({ index: -1, outerIndex: file.index, target, status: "skipped", notes });

  let steps: ChainStep[];
  try {
    steps = await chain.chainFor(target);
  } catch (e) {
    notes.push(`Could not collect the patches for ${target}: ${errorMessage(e)}`);
    return { ...base(), status: "failed" };
  }

  let baseSource: string;
  const className = target.endsWith(".java") ? target.slice(0, -".java".length) : null;
  if (className && decompiler.hasClass(className)) {
    try {
      baseSource = await decompiler.decompile(className);
    } catch (e) {
      notes.push(`Could not decompile ${className}: ${errorMessage(e)}`);
      return { ...base(), status: "failed" };
    }
  } else if (steps.length > 0 && createsFile(steps[0])) {
    baseSource = "";
  } else {
    notes.push(className ? "Class not found in the jar" : "Not a Java source file");
    return base();
  }
  const baseLines = baseSource.split("\n");

  let status: ResolvedStatus = "ok";
  const sides: Record<"old" | "new", string[]> = { old: baseLines, new: baseLines };
  const fuzzyCounts = { old: 0, new: 0 };
  for (const side of ["old", "new"] as const) {
    let lines = baseLines;
    for (const step of steps) {
      const text = step[side];
      if (text === null) continue;
      const result = fuzzyApply(lines, parseUnifiedPatch(text));
      lines = result.lines;
      fuzzyCounts[side] += result.hunks.filter((h) => h.status === "fuzzy").length;
      if (result.rejected > 0) {
        status = "partial";
        const which = result.hunks
          .map((h, i) => (h.status === "rejected" ? i + 1 : null))
          .filter((i) => i !== null)
          .join(", ");
        notes.push(
          `${step.label} (${side}): ${result.rejected} of ${result.hunks.length} hunks could not be placed (hunk ${which})`,
        );
      }
    }
    sides[side] = lines;
  }
  if (fuzzyCounts.old + fuzzyCounts.new > 0) {
    notes.push(`${fuzzyCounts.old} (old) / ${fuzzyCounts.new} (new) hunks placed with fuzzy context matching`);
  }
  if (steps.length > 1) {
    notes.push(`Applied on top of: ${steps.map((s) => s.label).join(", ")}`);
  }

  const oldSource = sides.old.join("\n");
  const newSource = sides.new.join("\n");
  if (oldSource === newSource) {
    status = "unchanged";
    notes.push("The change to the patch does not alter the resulting source");
  }

  const oneToOne = isSourcePatchPath(file.toFile || file.fromFile);
  const displayPath = oneToOne ? file.toFile : `${file.toFile || file.fromFile}/${target}`;
  const fromPath = oneToOne ? file.fromFile : displayPath;
  let fileStatus: FileStatus = oneToOne ? file.status : "modified";
  if (!oneToOne) {
    if (oldSource === "" && newSource !== "") fileStatus = "added";
    else if (newSource === "" && oldSource !== "") fileStatus = "removed";
  }
  // Same context as git (and thus GitHub) diffs, more can be revealed in the viewer
  const patchText = createTwoFilesPatch(target, target, oldSource, newSource, undefined, undefined, { context: 3 });
  // The patched sources are at hand, so the context shown around changes can be expanded further
  const fullFile =
    oldSource !== "" && newSource !== "" ? { side: "new" as const, load: async () => newSource } : undefined;
  const details = makeTextDetails(fromPath, displayPath, fileStatus, patchText, fullFile);
  return { ...base(), status, details };
}

function createsFile(step: ChainStep): boolean {
  const text = step.new ?? step.old;
  return text !== null && parseUnifiedPatch(text).oldFileName === null;
}
