import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(() => ({
  plugins: [tailwindcss(), sveltekit()],
  ssr: { noExternal: ["@sveltejs/kit", "chroma-js", "diff", "shiki"] },
  worker: { format: "es" },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // The Vineflower runtime conditionally imports Node modules; they are never used in the browser
        if (warning.code === "MODULE_EXTERNALIZED" && warning.message?.includes("wasm-runtime.js")) {
          return;
        }
        warn(warning);
      },
    },
  },
  // Tell Vitest to use the `browser` entry points in `package.json` files, even though it's running in Node
  resolve: process.env.VITEST
    ? {
        conditions: ["browser"],
      }
    : undefined,
}));
