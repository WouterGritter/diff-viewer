export const VINEFLOWER_VERSION = "1.12.0";

/**
 * Decompiler options matching PaperMC's mache configuration (which is what Paper's patches are
 * generated against). These are plain Vineflower preferences and are sensible for any jar.
 */
export const DEFAULT_DECOMPILER_OPTIONS: Record<string, string> = {
  "synthetic-not-set": "1",
  "ternary-constant-simplification": "1",
  "decompile-complex-constant-dynamic": "1",
  "indent-string": "    ",
  "decompile-inner": "1",
  "remove-bridge": "1",
  "decompile-generics": "1",
  "ascii-strings": "0",
  "remove-synthetic": "1",
  "inline-simple-lambdas": "1",
  "ignore-invalid-bytecode": "0",
  "bytecode-source-mapping": "1",
  "dump-code-lines": "1",
  "override-annotation": "1",
  "skip-extra-files": "1",
};

export type WorkerRequest =
  | { type: "init"; id: number; jar: ArrayBuffer; options: Record<string, string> }
  | { type: "decompile"; id: number; className: string };

export type WorkerResponse =
  | { type: "ready"; id: number; classCount: number }
  | { type: "result"; id: number; className: string; source: string }
  | { type: "error"; id: number; message: string };
