/// <reference lib="webworker" />
import wasmUrl from "@run-slicer/vf/vf.wasm?url";
import type * as vf from "@run-slicer/vf";
import { ZipReader } from "../zip";
import { parseClassFile, makeStubClass, type ClassInfo } from "../class-file";
import { normalizeNestedImports } from "../nested-imports";
import type { WorkerRequest, WorkerResponse } from "./protocol";

/**
 * Name of the synthetic class that is passed to Vineflower alongside the real target.
 * The WASM port only preloads classes referenced by the constant pools of the classes being
 * decompiled, so a stub referencing the wider closure (supertypes, outer classes) is used to make
 * it load what Vineflower needs for accurate override annotations and generic inference.
 */
const CONTEXT_STUB = "$diffs$context";

let runtime: typeof vf | null = null;
let jar: ZipReader | null = null;
let classNames: string[] = [];
let classSet = new Set<string>();
let options: Record<string, string> = {};
const classInfoCache = new Map<string, Promise<ClassInfo>>();

async function loadRuntime(): Promise<typeof vf> {
  if (runtime) return runtime;
  try {
    const { load } = await import("@run-slicer/vf/vf.wasm-runtime.js");
    const { exports } = await load(wasmUrl, { noAutoImports: true });
    runtime = exports;
  } catch (e) {
    console.warn("Failed to load Vineflower WASM runtime, falling back to the JavaScript build", e);
    runtime = await import("@run-slicer/vf/vf.runtime.js");
  }
  return runtime;
}

function classInfo(name: string): Promise<ClassInfo> {
  let info = classInfoCache.get(name);
  if (!info) {
    info = jar!.read(name + ".class").then(parseClassFile);
    classInfoCache.set(name, info);
  }
  return info;
}

function outerClasses(name: string): string[] {
  const outers: string[] = [];
  let dollar = name.lastIndexOf("$");
  while (dollar > 0) {
    outers.push(name.substring(0, dollar));
    dollar = name.lastIndexOf("$", dollar - 1);
  }
  return outers;
}

/**
 * Classes that Vineflower should have available when decompiling `targets`: everything the
 * targets reference directly (mirroring the WASM port's own analyzer), plus the transitive
 * supertypes and outer classes of all of those.
 */
async function contextClasses(targets: string[]): Promise<string[]> {
  const targetSet = new Set(targets);
  const wanted = new Set<string>();
  const stack: string[] = [];

  for (const target of targets) {
    for (const ref of (await classInfo(target)).references) {
      if (classSet.has(ref) && !targetSet.has(ref) && !wanted.has(ref)) {
        wanted.add(ref);
        stack.push(ref);
      }
    }
    stack.push(target);
  }

  while (stack.length > 0) {
    const name = stack.pop()!;
    const info = await classInfo(name);
    const related = [info.superName, ...info.interfaces, ...outerClasses(name)];
    for (const rel of related) {
      if (rel && classSet.has(rel) && !targetSet.has(rel) && !wanted.has(rel)) {
        wanted.add(rel);
        stack.push(rel);
      }
    }
  }

  return Array.from(wanted);
}

async function decompile(className: string): Promise<string> {
  if (!jar) throw new Error("Worker not initialized");
  if (!classSet.has(className)) throw new Error(`Class not found in jar: ${className}`);
  const vfRuntime = await loadRuntime();

  const targets = [className, ...classNames.filter((c) => c.startsWith(className + "$"))];
  const stub = makeStubClass(CONTEXT_STUB, await contextClasses(targets));

  const result = await vfRuntime.decompile([className, CONTEXT_STUB], {
    source: async (name) => {
      if (name === CONTEXT_STUB) return stub;
      const entry = name + ".class";
      return jar!.has(entry) ? await jar!.read(entry) : null;
    },
    resources: classNames,
    options,
    logger: {
      writeMessage(level, message, error) {
        if (level === "error") console.error(`[vineflower] ${message}`, error ?? "");
      },
    },
  });

  const source = result[className];
  if (source === undefined) {
    throw new Error(`Vineflower produced no output for ${className}`);
  }
  return normalizeNestedImports(source, (name) => classSet.has(name));
}

function respond(response: WorkerResponse) {
  postMessage(response);
}

onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    switch (request.type) {
      case "init": {
        jar = ZipReader.fromBytes(new Uint8Array(request.jar));
        classNames = Array.from(jar.entries.keys())
          .filter((n) => n.endsWith(".class"))
          .map((n) => n.slice(0, -".class".length))
          .sort();
        classSet = new Set(classNames);
        options = request.options;
        classInfoCache.clear();
        respond({ type: "ready", id: request.id, classCount: classNames.length });
        break;
      }
      case "decompile": {
        const source = await decompile(request.className);
        respond({ type: "result", id: request.id, className: request.className, source });
        break;
      }
    }
  } catch (e) {
    respond({ type: "error", id: request.id, message: e instanceof Error ? e.message : String(e) });
  }
};
