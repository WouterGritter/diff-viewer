import { DEFAULT_DECOMPILER_OPTIONS, VINEFLOWER_VERSION, type WorkerRequest, type WorkerResponse } from "./protocol";

const DECOMPILED_CACHE_NAME = "diffs-decompiled-cache-v1";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

class DecompilerWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  busy = 0;

  constructor() {
    this.worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module", name: "decompiler" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      const entry = this.pending.get(response.id);
      if (!entry) return;
      this.pending.delete(response.id);
      if (response.type === "error") {
        entry.reject(new Error(response.message));
      } else {
        entry.resolve(response);
      }
    };
    this.worker.onerror = (event) => {
      const error = new Error(`Decompiler worker error: ${event.message}`);
      for (const entry of this.pending.values()) entry.reject(error);
      this.pending.clear();
    };
  }

  private send(request: DistributiveOmit<WorkerRequest, "id">, transfer: Transferable[] = []): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: WorkerRequest = { ...request, id };
      this.worker.postMessage(message, transfer);
    });
  }

  async init(jar: ArrayBuffer, options: Record<string, string>): Promise<number> {
    const response = await this.send({ type: "init", jar, options }, [jar]);
    return response.type === "ready" ? response.classCount : 0;
  }

  async decompile(className: string): Promise<string> {
    this.busy++;
    try {
      const response = await this.send({ type: "decompile", className });
      if (response.type !== "result") throw new Error("Unexpected worker response");
      return response.source;
    } finally {
      this.busy--;
    }
  }

  terminate() {
    this.worker.terminate();
  }
}

export interface DecompilerOptions {
  /** Number of workers; each holds its own copy of the jar. */
  threads?: number;
  decompilerOptions?: Record<string, string>;
}

/**
 * A pool of decompiler workers sharing the same jar, with persistent caching of results.
 */
export class Decompiler {
  private readonly workers: DecompilerWorker[] = [];
  private readonly cacheKey: string;
  private readonly inFlight = new Map<string, Promise<string>>();
  private cache: Cache | null = null;
  classCount = 0;

  private constructor(cacheKey: string) {
    this.cacheKey = cacheKey;
  }

  static async create(jar: Uint8Array, cacheKey: string, options: DecompilerOptions = {}): Promise<Decompiler> {
    const decompiler = new Decompiler(cacheKey);
    const threads = Math.max(1, Math.min(options.threads ?? navigator.hardwareConcurrency ?? 2, 4));
    const decompilerOptions = options.decompilerOptions ?? DEFAULT_DECOMPILER_OPTIONS;
    if ("caches" in globalThis) {
      decompiler.cache = await caches.open(DECOMPILED_CACHE_NAME).catch(() => null);
    }
    const inits: Promise<number>[] = [];
    for (let i = 0; i < threads; i++) {
      const worker = new DecompilerWorker();
      decompiler.workers.push(worker);
      // Each worker needs its own copy; the buffer is transferred, so copy before sending
      const copy = jar.slice().buffer as ArrayBuffer;
      inits.push(worker.init(copy, decompilerOptions));
    }
    try {
      const counts = await Promise.all(inits);
      decompiler.classCount = counts[0] ?? 0;
    } catch (e) {
      decompiler.close();
      throw e;
    }
    return decompiler;
  }

  private cacheUrl(className: string): string {
    return `https://diffs.dev/cache/decompiled/vineflower-${VINEFLOWER_VERSION}/${this.cacheKey}/${className}.java`;
  }

  decompile(className: string): Promise<string> {
    let promise = this.inFlight.get(className);
    if (!promise) {
      promise = this.decompileUncached(className).finally(() => this.inFlight.delete(className));
      this.inFlight.set(className, promise);
    }
    return promise;
  }

  private async decompileUncached(className: string): Promise<string> {
    const url = this.cacheUrl(className);
    const cached = await this.cache?.match(url);
    if (cached) {
      return await cached.text();
    }

    const worker = this.workers.reduce((best, w) => (w.busy < best.busy ? w : best), this.workers[0]);
    const source = await worker.decompile(className);
    try {
      await this.cache?.put(url, new Response(source, { headers: { "Content-Type": "text/x-java-source" } }));
    } catch (e) {
      console.warn("Failed to cache decompiled source", e);
    }
    return source;
  }

  close() {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
  }
}
