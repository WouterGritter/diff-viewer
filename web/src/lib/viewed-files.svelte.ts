import { browser } from "$app/environment";
import type { FileDetails } from "$lib/file-details";
import { watchLocalStorage } from "$lib/util";

/** Entries beyond this count are dropped, least recently seen first */
export const VIEWED_FILES_MAX_ENTRIES = 10_000;
/** Entries not seen for this long are dropped */
export const VIEWED_FILES_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Hash of the file change to its last seen time */
export type ViewedEntries = Record<string, number>;

/** 53-bit string hash (cyrb53) */
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Identifies the change made to a file, independent of where the diff came from (a fork's commit,
 * a PR, the upstream commit, a patch file). Only the paths and the hunk lines are used, since
 * headers and line numbers differ between sources for the same change. Undefined for changes that
 * cannot be identified by their content (images, binary files).
 */
export function viewedKey(file: FileDetails): string | undefined {
  if (file.type !== "text" || file.binary) return undefined;
  const parts = [file.fromFile, file.toFile];
  for (const hunk of file.structuredPatch.hunks) {
    parts.push("@@", ...hunk.lines);
  }
  const text = parts.join("\n");
  // Two differently seeded hashes make collisions practically impossible
  return cyrb53(text, 0).toString(36) + cyrb53(text, 1).toString(36);
}

/** Drops expired entries and the oldest ones over the limit */
export function pruneViewedEntries(entries: ViewedEntries, now: number): ViewedEntries {
  const kept = Object.entries(entries).filter(([, time]) => now - time < VIEWED_FILES_MAX_AGE_MS);
  kept.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(kept.slice(0, VIEWED_FILES_MAX_ENTRIES));
}

/** Viewed state of files, remembered across page loads in local storage */
export class ViewedFilesStore {
  static readonly key = "diff-viewer-viewed-files";

  /** Number of remembered files */
  count = $state(0);

  constructor() {
    if (!browser) return;
    this.count = Object.keys(this.read()).length;
    watchLocalStorage(ViewedFilesStore.key, () => {
      this.count = Object.keys(this.read()).length;
    });
  }

  /** Returns which of the keys are remembered as viewed, marking them as seen now */
  restore(keys: (string | undefined)[]): Set<string> {
    const found = new Set<string>();
    if (!browser) return found;
    this.update((entries, now) => {
      for (const key of keys) {
        if (key !== undefined && key in entries) {
          entries[key] = now;
          found.add(key);
        }
      }
      return found.size > 0;
    });
    return found;
  }

  set(key: string | undefined, viewed: boolean) {
    if (!browser || key === undefined) return;
    this.update((entries, now) => {
      if (viewed) {
        entries[key] = now;
      } else if (key in entries) {
        delete entries[key];
      } else {
        return false;
      }
      return true;
    });
  }

  clear() {
    if (!browser) return;
    localStorage.removeItem(ViewedFilesStore.key);
    this.count = 0;
  }

  private read(): ViewedEntries {
    try {
      const parsed = JSON.parse(localStorage.getItem(ViewedFilesStore.key) ?? "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Read-modify-write, so changes made in other tabs in the meantime are kept */
  private update(modify: (entries: ViewedEntries, now: number) => boolean) {
    const now = Date.now();
    const entries = this.read();
    if (!modify(entries, now)) return;
    const pruned = pruneViewedEntries(entries, now);
    try {
      localStorage.setItem(ViewedFilesStore.key, JSON.stringify(pruned));
    } catch (e) {
      console.error("Failed to save viewed files:", e);
    }
    this.count = Object.keys(pruned).length;
  }
}
