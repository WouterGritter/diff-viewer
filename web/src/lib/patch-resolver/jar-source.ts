import { ZipReader } from "./zip";

/**
 * Where the jar to decompile comes from: either a Minecraft version (resolved via Mojang's
 * version manifest to the official server jar download) or a direct URL to any jar.
 */
export type JarSource = { kind: "minecraft"; version: string } | { kind: "url"; url: string };

export interface ResolvedJar {
  /** Human readable description, e.g. "Minecraft 26.2 server" */
  label: string;
  /** Stable identifier used for caching decompiled output (jar sha1 when known, else the URL) */
  cacheKey: string;
  /** Raw bytes of the jar whose classes should be decompiled */
  bytes: Uint8Array;
}

export interface JarProgress {
  stage: "manifest" | "download" | "extract";
  /** 0-1 when known */
  fraction?: number;
  message: string;
}

const VERSION_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const JAR_CACHE_NAME = "diffs-jar-cache-v1";

export interface MinecraftVersionEntry {
  id: string;
  type: string;
  url: string;
  releaseTime: string;
  sha1: string;
}

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: MinecraftVersionEntry[];
}

interface VersionPackage {
  id: string;
  downloads: {
    server?: { url: string; sha1: string; size: number };
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} (${response.status})`);
  }
  return (await response.json()) as T;
}

let manifestPromise: Promise<VersionManifest> | null = null;

export function fetchMinecraftVersions(): Promise<MinecraftVersionEntry[]> {
  if (!manifestPromise) {
    manifestPromise = fetchJson<VersionManifest>(VERSION_MANIFEST_URL).catch((e) => {
      manifestPromise = null;
      throw e;
    });
  }
  return manifestPromise.then((m) => m.versions);
}

/**
 * Mojang started shipping unobfuscated jars with 26.1-snapshot-1 (2025-12-16). Older
 * versions would need to be remapped with the official mappings first, which is not supported.
 */
export function isUnobfuscatedVersion(entry: MinecraftVersionEntry): boolean {
  return new Date(entry.releaseTime) >= new Date("2025-12-16T00:00:00Z");
}

async function cachedFetch(url: string, onProgress: (fraction: number | undefined) => void): Promise<Blob> {
  const cache = "caches" in globalThis ? await caches.open(JAR_CACHE_NAME).catch(() => null) : null;
  const cached = await cache?.match(url);
  if (cached) {
    return await cached.blob();
  }

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url} (${response.status})`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array<ArrayBuffer>);
    received += value.length;
    onProgress(contentLength > 0 ? received / contentLength : undefined);
  }
  const blob = new Blob(chunks);
  try {
    await cache?.put(url, new Response(blob, { headers: { "Content-Type": "application/java-archive" } }));
  } catch (e) {
    console.warn("Failed to cache jar", e);
  }
  return blob;
}

/**
 * Mojang's server jar is a "bundler" jar wrapping the real server jar plus libraries.
 * Returns the inner server jar bytes when the given jar is a bundler, otherwise the input.
 */
export async function unwrapBundlerJar(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = ZipReader.fromBytes(bytes);
  if (!zip.has("META-INF/versions.list")) {
    return bytes;
  }
  const list = (await zip.readText("META-INF/versions.list")).trim();
  const entry = list.split("\n")[0]?.split("\t");
  if (!entry || entry.length < 3) {
    throw new Error("Unrecognized bundler jar: malformed META-INF/versions.list");
  }
  const innerPath = `META-INF/versions/${entry[2]}`;
  if (!zip.has(innerPath)) {
    throw new Error(`Unrecognized bundler jar: missing ${innerPath}`);
  }
  return await zip.read(innerPath);
}

export async function resolveJar(source: JarSource, onProgress: (progress: JarProgress) => void): Promise<ResolvedJar> {
  let url: string;
  let label: string;
  let cacheKey: string;

  if (source.kind === "minecraft") {
    onProgress({ stage: "manifest", message: "Fetching Minecraft version manifest" });
    const versions = await fetchMinecraftVersions();
    const entry = versions.find((v) => v.id === source.version);
    if (!entry) {
      throw new Error(`Unknown Minecraft version '${source.version}'`);
    }
    if (!isUnobfuscatedVersion(entry)) {
      throw new Error(
        `Minecraft ${entry.id} ships obfuscated; only versions from 26.1-snapshot-1 onwards are supported`,
      );
    }
    const pkg = await fetchJson<VersionPackage>(entry.url);
    if (!pkg.downloads.server) {
      throw new Error(`Minecraft ${entry.id} has no server jar download`);
    }
    url = pkg.downloads.server.url;
    label = `Minecraft ${entry.id} server`;
    cacheKey = `minecraft/${entry.id}/${pkg.downloads.server.sha1}`;
  } else {
    url = source.url;
    label = url.substring(url.lastIndexOf("/") + 1) || url;
    cacheKey = `url/${encodeURIComponent(url)}`;
  }

  onProgress({ stage: "download", fraction: 0, message: `Downloading ${label}` });
  const blob = await cachedFetch(url, (fraction) => {
    onProgress({ stage: "download", fraction, message: `Downloading ${label}` });
  });

  onProgress({ stage: "extract", message: `Extracting ${label}` });
  const bytes = await unwrapBundlerJar(new Uint8Array(await blob.arrayBuffer()));
  return { label, cacheKey, bytes };
}
