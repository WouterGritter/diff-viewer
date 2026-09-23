import type { FileDetails } from "$lib/file-details";
import type { GithubDiff } from "$lib/github-api";
import { fetchGithubFileText } from "$lib/github-api";
import { getGithubToken } from "$lib/github-auth.svelte";
import type { JarSource } from "$lib/patch-resolver/jar-source";
import { isResolvablePatch } from "$lib/patch-resolver/patch-chain";
import type { ResolvedEntry, ResolvedFile, ResolveProgress, ResolveSummary } from "$lib/patch-resolver/resolver";
import { formatErrorWithCauses } from "$lib/util";
import { SvelteSet } from "svelte/reactivity";
import { ProgressBarState } from "$lib/components/progress-bar/index.svelte";
import { browser } from "$app/environment";

export type JarSourceKind = JarSource["kind"];

/** The license confirmation is remembered across sessions, it is the same answer every time */
const LICENSE_ACCEPTED_KEY = "diff-viewer-decompile-license-accepted";

/** What the viewer shows for a file: a resolved target, or the raw patch file it was resolved from */
export type ResolvedInfo =
  { kind: "entry"; entry: ResolvedEntry; file: ResolvedFile } | { kind: "file"; file: ResolvedFile };

/**
 * State for resolving "patch of a patch" diffs (e.g. PaperMC's `*.java.patch` files) against a
 * decompiled jar, and for switching the viewer between the raw and resolved representations.
 */
export class PatchResolverState {
  /** Reserves viewer indices (and file states) for resolved entries that do not replace a file one-to-one */
  private readonly allocateIndices: (files: FileDetails[]) => number;

  constructor(allocateIndices: (files: FileDetails[]) => number) {
    this.allocateIndices = allocateIndices;
  }

  // Form state
  sourceKind: JarSourceKind = $state("minecraft");
  minecraftVersion = $state("");
  jarUrl = $state("");
  #licenseAccepted = $state(browser && localStorage.getItem(LICENSE_ACCEPTED_KEY) === "true");
  /** Version detected from the repository (e.g. Paper's gradle.properties), if any */
  detectedVersion: string | null = $state(null);

  // Progress state
  running = $state(false);
  progress: ResolveProgress | null = $state(null);
  readonly progressBar = new ProgressBarState(null, 100);
  private abortController: AbortController | null = null;

  // Results
  summary: ResolveSummary | null = $state.raw(null);
  showResolved = $state(true);
  /** Files for which the raw patch should be shown even though a resolved diff exists */
  readonly rawOverrides = new SvelteSet<number>();

  readonly byOuterIndex: Map<number, ResolvedFile> = $derived.by(() => {
    const map = new Map<number, ResolvedFile>();
    if (this.summary) {
      for (const file of this.summary.files) map.set(file.index, file);
    }
    return map;
  });

  readonly byEntryIndex: Map<number, { entry: ResolvedEntry; file: ResolvedFile }> = $derived.by(() => {
    const map = new Map<number, { entry: ResolvedEntry; file: ResolvedFile }>();
    if (this.summary) {
      for (const file of this.summary.files) {
        for (const entry of file.entries) if (entry.details) map.set(entry.index, { entry, file });
      }
    }
    return map;
  });

  readonly stats = $derived.by(() => {
    const stats = { ok: 0, partial: 0, unchanged: 0, failed: 0, skipped: 0 };
    if (this.summary) {
      for (const file of this.summary.files) stats[file.status]++;
    }
    return stats;
  });

  get licenseAccepted() {
    return this.#licenseAccepted;
  }

  set licenseAccepted(accepted: boolean) {
    this.#licenseAccepted = accepted;
    if (browser) {
      localStorage.setItem(LICENSE_ACCEPTED_KEY, "" + accepted);
    }
  }

  /** Resolution info for a file as currently shown in the viewer */
  get(file: FileDetails): ResolvedInfo | undefined {
    const entry = this.byEntryIndex.get(file.index);
    if (entry && this.isShowingResolved(file)) return { kind: "entry", ...entry };
    const outer = this.byOuterIndex.get(file.index);
    return outer ? { kind: "file", file: outer } : undefined;
  }

  private outerIndex(file: FileDetails): number {
    return this.byEntryIndex.get(file.index)?.entry.outerIndex ?? file.index;
  }

  /** Whether the viewer currently shows a resolved diff for this file */
  isShowingResolved(file: FileDetails): boolean {
    if (!this.showResolved) return false;
    const outer = this.outerIndex(file);
    if (this.rawOverrides.has(outer)) return false;
    return this.byOuterIndex.get(outer)?.entries.some((e) => e.details !== undefined) ?? false;
  }

  hasResolvedDiff(file: FileDetails): boolean {
    return this.byOuterIndex.get(this.outerIndex(file))?.entries.some((e) => e.details !== undefined) ?? false;
  }

  toggleFile(file: FileDetails) {
    const outer = this.outerIndex(file);
    if (this.rawOverrides.has(outer)) {
      this.rawOverrides.delete(outer);
    } else {
      this.rawOverrides.add(outer);
    }
  }

  /** Substitutes resolved diffs into the raw file list according to the current toggles */
  applyTo(raw: FileDetails[]): FileDetails[] {
    if (!this.summary || !this.showResolved) return raw;
    return raw.flatMap((file) => {
      if (this.rawOverrides.has(file.index)) return [file];
      const resolved = this.byOuterIndex.get(file.index);
      if (!resolved) return [file];
      const details: FileDetails[] = [];
      for (const entry of resolved.entries) if (entry.details) details.push(entry.details);
      return details.length > 0 ? details : [file];
    });
  }

  /** Assigns viewer indices to resolved entries that are shown in addition to (instead of) their patch file */
  private assignIndices(summary: ResolveSummary) {
    const pending: ResolvedEntry[] = [];
    for (const file of summary.files) {
      for (const entry of file.entries) if (entry.details && entry.index === -1) pending.push(entry);
    }
    if (pending.length === 0) return;
    let index = this.allocateIndices(pending.map((entry) => entry.details!));
    for (const entry of pending) {
      entry.index = index++;
      entry.details!.index = entry.index;
    }
  }

  reset() {
    this.cancel();
    this.summary = null;
    this.rawOverrides.clear();
    this.detectedVersion = null;
    this.progress = null;
  }

  cancel() {
    this.abortController?.abort();
    this.abortController = null;
  }

  static countNestedPatches(files: FileDetails[]): number {
    let count = 0;
    for (const file of files) if (isResolvablePatch(file)) count++;
    return count;
  }

  /**
   * Tries to detect the Minecraft version the repository targets. Currently understands
   * paperweight-based repositories (`mcVersion` in gradle.properties).
   */
  async detectVersion(github: GithubDiff): Promise<string | null> {
    if (this.detectedVersion !== null) return this.detectedVersion;
    try {
      const text = await fetchGithubFileText(
        getGithubToken(),
        github.owner,
        github.repo,
        "gradle.properties",
        github.head,
      );
      const match = /^\s*mcVersion\s*=\s*(\S+)/m.exec(text);
      if (match) {
        this.detectedVersion = match[1];
        if (!this.minecraftVersion) this.minecraftVersion = match[1];
      }
    } catch (e) {
      console.info("Could not detect Minecraft version from repository", e);
    }
    return this.detectedVersion;
  }

  private jarSource(): JarSource {
    if (this.sourceKind === "url") {
      return { kind: "url", url: this.jarUrl.trim() };
    }
    return { kind: "minecraft", version: this.minecraftVersion.trim() };
  }

  /**
   * Runs the resolver for the given diff.
   * @param opts.jar the jar to resolve against, instead of the one selected in the form
   * @param opts.quiet log failures instead of alerting, for runs the user did not start themselves
   * @returns true on success, false when the run failed (an alert has been shown unless quiet) or was cancelled
   */
  async run(github: GithubDiff, files: FileDetails[], opts?: { jar?: JarSource; quiet?: boolean }): Promise<boolean> {
    if (this.running) return false;
    if (!this.licenseAccepted) {
      alert("Please confirm that you own a license for the software being decompiled.");
      return false;
    }
    const source = opts?.jar ?? this.jarSource();
    if (source.kind === "minecraft" && !source.version) {
      alert("Please enter a Minecraft version.");
      return false;
    }
    if (source.kind === "url" && !source.url) {
      alert("Please enter a jar URL.");
      return false;
    }

    this.running = true;
    this.progressBar.setSpinning();
    this.abortController = new AbortController();
    try {
      // Loaded lazily: pulls in the decompiler worker, which is only ever needed in the browser
      const { resolveNestedPatches } = await import("$lib/patch-resolver/resolver");
      const summary = await resolveNestedPatches(getGithubToken(), github, files, {
        jar: source,
        signal: this.abortController.signal,
        onProgress: (progress) => {
          this.progress = progress;
          if (progress.fraction === undefined) {
            this.progressBar.setSpinning();
          } else {
            this.progressBar.setProgress(progress.fraction * 100, 100);
          }
        },
      });
      this.assignIndices(summary);
      this.summary = summary;
      this.rawOverrides.clear();
      this.showResolved = true;
      return true;
    } catch (e) {
      if (this.abortController?.signal.aborted) {
        return false;
      }
      console.error("Failed to resolve patches:", e);
      if (!opts?.quiet) alert(formatErrorWithCauses(e));
      return false;
    } finally {
      this.running = false;
      this.progress = null;
      this.abortController = null;
    }
  }
}
