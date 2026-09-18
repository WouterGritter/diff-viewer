import type { FileDetails } from "$lib/file-details";
import type { GithubDiff } from "$lib/github-api";
import { fetchGithubFileText } from "$lib/github-api";
import { getGithubToken } from "$lib/github-auth.svelte";
import type { JarSource } from "$lib/patch-resolver/jar-source";
import { isNestedJavaPatch } from "$lib/patch-resolver/nested-patch";
import type { ResolvedFile, ResolveProgress, ResolveSummary } from "$lib/patch-resolver/resolver";
import { formatErrorWithCauses } from "$lib/util";
import { SvelteSet } from "svelte/reactivity";
import { ProgressBarState } from "$lib/components/progress-bar/index.svelte";

export type JarSourceKind = JarSource["kind"];

export const DEFAULT_RESOLVED_CONTEXT_LINES = 10;

/**
 * State for resolving "patch of a patch" diffs (e.g. PaperMC's `*.java.patch` files) against a
 * decompiled jar, and for switching the viewer between the raw and resolved representations.
 */
export class PatchResolverState {
  // Form state
  sourceKind: JarSourceKind = $state("minecraft");
  minecraftVersion = $state("");
  jarUrl = $state("");
  licenseAccepted = $state(false);
  contextLines = $state(DEFAULT_RESOLVED_CONTEXT_LINES);
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

  readonly byIndex: Map<number, ResolvedFile> = $derived.by(() => {
    const map = new Map<number, ResolvedFile>();
    if (this.summary) {
      for (const file of this.summary.files) map.set(file.index, file);
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

  get(file: FileDetails): ResolvedFile | undefined {
    return this.byIndex.get(file.index);
  }

  /** Whether the viewer currently shows the resolved diff for this file */
  isShowingResolved(file: FileDetails): boolean {
    if (!this.showResolved || this.rawOverrides.has(file.index)) return false;
    return this.byIndex.get(file.index)?.details !== undefined;
  }

  toggleFile(file: FileDetails) {
    if (this.rawOverrides.has(file.index)) {
      this.rawOverrides.delete(file.index);
    } else {
      this.rawOverrides.add(file.index);
    }
  }

  /** Substitutes resolved diffs into the raw file list according to the current toggles */
  applyTo(raw: FileDetails[]): FileDetails[] {
    if (!this.summary || !this.showResolved) return raw;
    return raw.map((file) => {
      if (this.rawOverrides.has(file.index)) return file;
      return this.byIndex.get(file.index)?.details ?? file;
    });
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
    for (const file of files) if (isNestedJavaPatch(file)) count++;
    return count;
  }

  /**
   * Tries to detect the Minecraft version the repository targets. Currently understands
   * paperweight-based repositories (`mcVersion` in gradle.properties).
   */
  async detectVersion(github: GithubDiff) {
    if (this.detectedVersion !== null) return;
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
  }

  private jarSource(): JarSource {
    if (this.sourceKind === "url") {
      return { kind: "url", url: this.jarUrl.trim() };
    }
    return { kind: "minecraft", version: this.minecraftVersion.trim() };
  }

  /**
   * Runs the resolver for the given diff.
   * @returns true on success, false when the run failed (an alert has been shown) or was cancelled
   */
  async run(github: GithubDiff, files: FileDetails[]): Promise<boolean> {
    if (this.running) return false;
    if (!this.licenseAccepted) {
      alert("Please confirm that you own a license for the software being decompiled.");
      return false;
    }
    const source = this.jarSource();
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
        contextLines: Math.max(0, Math.floor(this.contextLines)),
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
      this.summary = summary;
      this.rawOverrides.clear();
      this.showResolved = true;
      return true;
    } catch (e) {
      if (this.abortController?.signal.aborted) {
        return false;
      }
      console.error("Failed to resolve patches:", e);
      alert(formatErrorWithCauses(e));
      return false;
    } finally {
      this.running = false;
      this.progress = null;
      this.abortController = null;
    }
  }
}
