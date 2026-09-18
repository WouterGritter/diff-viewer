import cloudflareAdapter from "@sveltejs/adapter-cloudflare";
import nodeAdapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),

  kit: {
    // Cloudflare Pages by default; `ADAPTER=node pnpm run build` produces a self-hosted Node server (see Dockerfile)
    adapter: process.env.ADAPTER === "node" ? nodeAdapter() : cloudflareAdapter(),
  },
};

export default config;
