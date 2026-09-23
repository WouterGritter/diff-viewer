import { fetchGithubDirectory, fetchGithubFileText, type GithubDiff, type GithubDirectoryEntry } from "$lib/github-api";
import type { FileDetails } from "$lib/file-details";

/**
 * Model of paperweight-style patch repositories: a *patches root* (`paper-server/patches` for
 * Paper, `<fork>-server/minecraft-patches` for forks) containing
 *
 * - `sources/<path>.java.patch`: per-file unified diffs applied first, and
 * - `features/NNNN-*.patch`: git-format multi-file patches applied afterwards in order.
 *
 * Forks build on top of an upstream repository's fully patched sources, referenced by a commit
 * (`paperRef` in gradle.properties), which forms an earlier *layer* of the chain.
 */

export interface PatchLayer {
  owner: string;
  repo: string;
  /** Commit the unchanged patches of this layer are read from */
  ref: string;
  /** e.g. paper-server/patches */
  root: string;
  label: string;
}

export interface OuterPatchChange {
  /** Content of the patch file before the change, null when the file was added */
  oldText: string | null;
  /** Content after the change, null when the file was removed */
  newText: string | null;
}

/** A single patch to apply to one target file, possibly differing between the old and new side */
export interface ChainStep {
  label: string;
  old: string | null;
  new: string | null;
}

export interface FeaturePatch {
  path: string;
  name: string;
  sections: Map<string, string>;
}

const RAW_CACHE_NAME = "diffs-github-raw-v1";
const NON_FEATURE_DIRS = new Set(["sources", "resources", "rejected"]);
const SHA_REGEX = /^[0-9a-f]{40}$/;

async function cachedFileText(
  token: string | null,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const cacheable = SHA_REGEX.test(ref) && "caches" in globalThis;
  const cacheUrl = `https://diffs.dev/cache/github-raw/${owner}/${repo}/${ref}/${path}`;
  const cache = cacheable ? await caches.open(RAW_CACHE_NAME).catch(() => null) : null;
  const cached = await cache?.match(cacheUrl);
  if (cached) {
    return cached.status === 204 ? null : await cached.text();
  }
  let text: string | null;
  try {
    text = await fetchGithubFileText(token, owner, repo, path, ref);
  } catch (e) {
    if (e instanceof Error && /\(404\)/.test(e.message)) {
      text = null;
    } else {
      throw e;
    }
  }
  try {
    await cache?.put(cacheUrl, text === null ? new Response(null, { status: 204 }) : new Response(text));
  } catch (e) {
    console.warn("Failed to cache file", e);
  }
  return text;
}

/**
 * Directory listings go through the GitHub API, which has a low unauthenticated rate limit, so
 * they are cached permanently for immutable (commit sha) refs.
 */
async function cachedDirectory(
  token: string | null,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<GithubDirectoryEntry[]> {
  const cacheable = SHA_REGEX.test(ref) && "caches" in globalThis;
  const cacheUrl = `https://diffs.dev/cache/github-dir/${owner}/${repo}/${ref}/${path}`;
  const cache = cacheable ? await caches.open(RAW_CACHE_NAME).catch(() => null) : null;
  const cached = await cache?.match(cacheUrl);
  if (cached) {
    return (await cached.json()) as GithubDirectoryEntry[];
  }
  let entries: GithubDirectoryEntry[];
  try {
    entries = await fetchGithubDirectory(token, owner, repo, path, ref);
  } catch (e) {
    if (e instanceof Error && /rate limit/i.test(e.message)) {
      throw new Error(
        "GitHub API rate limit exceeded while listing patch directories. Sign in to GitHub (Open dialog) for a higher limit, or try again later.",
        { cause: e },
      );
    }
    throw e;
  }
  // Only keep what is needed, listings of large directories are sizeable
  const slim = entries.map(({ name, path, type, size }) => ({ name, path, type, size }));
  try {
    await cache?.put(cacheUrl, new Response(JSON.stringify(slim), { headers: { "Content-Type": "application/json" } }));
  } catch (e) {
    console.warn("Failed to cache directory listing", e);
  }
  return slim;
}

/** Splits a git-format patch into its per-file sections, keyed by the target (or removed) path */
export function splitFeaturePatch(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = text.split("\n");
  let current: string[] | null = null;
  let currentPath: string | null = null;
  const flush = () => {
    if (current && currentPath) sections.set(currentPath, current.join("\n"));
  };
  for (const line of lines) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (header) {
      flush();
      current = [line];
      currentPath = header[2];
      continue;
    }
    if (current === null) continue;
    if (line === "-- ") {
      // git signature at the end of the patch
      flush();
      current = null;
      continue;
    }
    current.push(line);
  }
  flush();
  return sections;
}

/**
 * Strips what changes when an earlier patch shifts lines: blob hashes on `index` lines and the
 * line numbers of hunk headers
 */
function normalizeSection(section: string): string {
  return section
    .replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/gm, "")
    .replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/gm, "@@");
}

/** Targets of a feature patch whose sections differ between the old and new version, beyond patch headers */
export function changedFeatureTargets(change: OuterPatchChange): string[] {
  const oldSections = change.oldText === null ? new Map<string, string>() : splitFeaturePatch(change.oldText);
  const newSections = change.newText === null ? new Map<string, string>() : splitFeaturePatch(change.newText);
  const targets = new Set<string>();
  for (const [target, section] of newSections) {
    const old = oldSections.get(target);
    if (old === undefined || normalizeSection(old) !== normalizeSection(section)) targets.add(target);
  }
  for (const target of oldSections.keys()) {
    if (!newSections.has(target)) targets.add(target);
  }
  return Array.from(targets).sort();
}

export function isFeaturePatchPath(path: string): boolean {
  return /(^|\/)(patches|minecraft-patches)\/[^/]+\/[^/]+\.patch$/.test(path) && !path.endsWith(".java.patch");
}

export function isSourcePatchPath(path: string): boolean {
  return path.endsWith(".java.patch");
}

/** Whether a file in a loaded diff is a patch that could be resolved against the source it targets */
export function isResolvablePatch(file: FileDetails): boolean {
  if (file.type !== "text") return false;
  const path = file.toFile || file.fromFile;
  return isSourcePatchPath(path) || isFeaturePatchPath(path);
}

/** `paper-server/patches/features/0001-x.patch` -> `paper-server/patches` */
export function patchesRootOf(path: string): string | null {
  const match = /^(.*?(?:^|\/)(?:patches|minecraft-patches))\//.exec(path);
  return match ? match[1] : null;
}

/** Target path of a `sources/<path>.java.patch` file relative to the patches root */
export function sourcePatchTarget(root: string, path: string): string | null {
  const prefix = `${root}/sources/`;
  if (!path.startsWith(prefix) || !path.endsWith(".patch")) return null;
  return path.substring(prefix.length, path.length - ".patch".length);
}

export class PatchChainBuilder {
  private readonly featureCache = new Map<string, Promise<FeaturePatch[]>>();
  private readonly sourceCache = new Map<string, Promise<string | null>>();

  private readonly token: string | null;
  /** Layers from the furthest upstream to the repository being viewed */
  readonly layers: PatchLayer[];
  /** Patch files changed by the viewed diff (paths in the last layer), with their old/new contents */
  private readonly changes: Map<string, OuterPatchChange>;
  private readonly onFetch?: (message: string) => void;

  constructor(
    token: string | null,
    layers: PatchLayer[],
    changes: Map<string, OuterPatchChange>,
    onFetch?: (message: string) => void,
  ) {
    this.token = token;
    this.layers = layers;
    this.changes = changes;
    this.onFetch = onFetch;
  }

  /**
   * Discovers the layers for a GitHub diff: the repository itself plus its paperweight upstream
   * if `gradle.properties` references one.
   */
  static async discoverLayers(token: string | null, github: GithubDiff, root: string): Promise<PatchLayer[]> {
    const self: PatchLayer = { owner: github.owner, repo: github.repo, ref: github.head, root, label: github.repo };
    const layers: PatchLayer[] = [self];
    const properties = await cachedFileText(token, github.owner, github.repo, "gradle.properties", github.head);
    const paperRef = properties ? /^\s*paperRef\s*=\s*([0-9a-fA-F]{7,40})\s*$/m.exec(properties)?.[1] : undefined;
    if (paperRef && !(github.owner === "PaperMC" && github.repo === "Paper")) {
      layers.unshift({ owner: "PaperMC", repo: "Paper", ref: paperRef, root: "paper-server/patches", label: "Paper" });
    }
    return layers;
  }

  private isLastLayer(layer: PatchLayer): boolean {
    return layer === this.layers[this.layers.length - 1];
  }

  /** Fetches and splits all feature patches of a layer (as of the layer's ref) */
  featurePatches(layer: PatchLayer): Promise<FeaturePatch[]> {
    const key = `${layer.owner}/${layer.repo}@${layer.ref}/${layer.root}`;
    let promise = this.featureCache.get(key);
    if (!promise) {
      promise = this.loadFeaturePatches(layer);
      this.featureCache.set(key, promise);
    }
    return promise;
  }

  /**
   * Directories under the patches root holding git-format feature patches. Paper uses `features`;
   * forks may add others (e.g. `base`), which are assumed to apply in alphabetical order.
   */
  private async featureDirectories(layer: PatchLayer): Promise<string[]> {
    const entries = await cachedDirectory(this.token, layer.owner, layer.repo, layer.root, layer.ref);
    const dirs = new Set(
      entries.filter((e) => e.type === "dir" && !NON_FEATURE_DIRS.has(e.name)).map((e) => `${layer.root}/${e.name}`),
    );
    if (this.isLastLayer(layer)) {
      for (const path of this.changes.keys()) {
        if (isFeaturePatchPath(path) && path.startsWith(layer.root + "/")) {
          dirs.add(path.substring(0, path.lastIndexOf("/")));
        }
      }
    }
    return Array.from(dirs).sort();
  }

  private async loadFeaturePatches(layer: PatchLayer): Promise<FeaturePatch[]> {
    const names = new Set<string>();
    for (const dir of await this.featureDirectories(layer)) {
      const entries = await cachedDirectory(this.token, layer.owner, layer.repo, dir, layer.ref);
      for (const e of entries) if (e.type === "file" && e.name.endsWith(".patch")) names.add(e.path);
      if (this.isLastLayer(layer)) {
        // Feature patches removed by the viewed diff no longer exist at head but still apply on the old side
        for (const [path, change] of this.changes) {
          if (path.startsWith(dir + "/") && change.newText === null) names.add(path);
        }
      }
    }
    const paths = Array.from(names).sort();
    let done = 0;
    const patches = await Promise.all(
      paths.map(async (path) => {
        const text = await this.outerPatchText(layer, path);
        done++;
        this.onFetch?.(`Fetching ${layer.label} feature patches (${done}/${paths.length})`);
        return { path, name: path.substring(path.lastIndexOf("/") + 1), text };
      }),
    );
    return patches.map((p) => ({
      path: p.path,
      name: p.name,
      sections: p.text === null ? new Map() : splitFeaturePatch(p.text),
    }));
  }

  /** Contents of a patch file at the layer's ref (the *new* side for changed files) */
  private outerPatchText(layer: PatchLayer, path: string): Promise<string | null> {
    if (this.isLastLayer(layer)) {
      const change = this.changes.get(path);
      if (change) return Promise.resolve(change.newText ?? change.oldText);
    }
    const key = `${layer.owner}/${layer.repo}@${layer.ref}/${path}`;
    let promise = this.sourceCache.get(key);
    if (!promise) {
      promise = cachedFileText(this.token, layer.owner, layer.repo, path, layer.ref);
      this.sourceCache.set(key, promise);
    }
    return promise;
  }

  private step(layer: PatchLayer, path: string, label: string, text: string | null): ChainStep | null {
    const change = this.isLastLayer(layer) ? this.changes.get(path) : undefined;
    if (change) {
      return { label, old: change.oldText, new: change.newText };
    }
    return text === null ? null : { label, old: text, new: text };
  }

  private featureStep(layer: PatchLayer, patch: FeaturePatch, target: string): ChainStep | null {
    const change = this.isLastLayer(layer) ? this.changes.get(patch.path) : undefined;
    const label = `${layer.label} ${patch.name}`;
    if (change) {
      const oldSection = change.oldText === null ? null : (splitFeaturePatch(change.oldText).get(target) ?? null);
      const newSection = change.newText === null ? null : (splitFeaturePatch(change.newText).get(target) ?? null);
      if (oldSection === null && newSection === null) return null;
      return { label, old: oldSection, new: newSection };
    }
    const section = patch.sections.get(target);
    return section === undefined ? null : { label, old: section, new: section };
  }

  /**
   * Builds the ordered list of patches that apply to `target` (e.g. `net/minecraft/server/Main.java`)
   * across all layers.
   */
  async chainFor(target: string): Promise<ChainStep[]> {
    const steps: ChainStep[] = [];
    for (const layer of this.layers) {
      const sourcePath = `${layer.root}/sources/${target}.patch`;
      const sourceStep = this.step(
        layer,
        sourcePath,
        `${layer.label} sources patch`,
        await this.outerPatchText(layer, sourcePath),
      );
      if (sourceStep) steps.push(sourceStep);
      for (const patch of await this.featurePatches(layer)) {
        const featureStep = this.featureStep(layer, patch, target);
        if (featureStep) steps.push(featureStep);
      }
    }
    return steps;
  }
}
