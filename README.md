# [Diff Viewer](https://diffs.gritter.nl)
Featureful and performant web-based diff viewer.

> **This is a fork**, hosted at **[diffs.gritter.nl](https://diffs.gritter.nl)**.
>
> Upstream is [PaperMC/diff-viewer](https://github.com/PaperMC/diff-viewer) (hosted at [diffs.dev](https://diffs.dev)).
> This fork adds [patch-of-patch diff resolving](#resolving-patch-of-patch-diffs), which decompiles the jar that a
> Paper-style repository patches and shows the diff of the actual patched source instead of the diff of the patch
> files. That is not intended to be merged upstream, so this fork is maintained and deployed separately.

## Overview

### Routes

- [`/`](https://diffs.gritter.nl): Multi-file concise diff viewer

### Tech Stack

SvelteKit frontend using tailwindcss for styling, deployed to Cloudflare Pages via GitHub Actions.

This fork can also be self-hosted with Docker: `docker compose up -d --build` builds the frontend with SvelteKit's
Node adapter and serves it on port 3000. "Login with GitHub" additionally needs a `GITHUB_CLIENT_SECRET` in the
environment, and the matching GitHub App's client ID and name in `web/.env` before building.

### Resolving patch-of-patch diffs

Repositories such as [PaperMC/Paper](https://github.com/PaperMC/Paper) cannot redistribute the source they modify and
instead store patches (per-file `sources/**/*.java.patch` files and git-format `features/*.patch` files, applied in
that order), so a diff of the repository is a diff of patch files. For diffs loaded from GitHub that contain such
files, **Resolve patches** (in the toolbar) downloads the jar the patches target, decompiles the affected classes
locally in the browser, applies the repository's other patches for those classes in order (and, for forks, the
upstream Paper patches referenced by `paperRef`), and shows the diff of the actual patched source with surrounding code
for context. A feature patch touching several classes expands into one diff per class.

- The jar is fetched straight from its origin (Mojang's servers for Minecraft versions, or any URL) into the browser and
  is never uploaded or redistributed. You must own a license for the software being decompiled.
- Decompilation uses [Vineflower](https://github.com/Vineflower/vineflower) 1.12.0 compiled to WebAssembly
  ([@run-slicer/vf](https://www.npmjs.com/package/@run-slicer/vf)), configured like PaperMC's
  [mache](https://github.com/PaperMC/mache) so the output closely matches the source Paper's patches are made against.
  Steps of Paper's pipeline that cannot run in the browser (codebook, access transformers, mache patches) are not
  reproduced, so patches are applied with fuzzy context matching; hunks that cannot be placed are reported per file and
  the raw patch diff remains available.
- Only unobfuscated Minecraft versions (26.1-snapshot-1 and later) are supported.

### Web Extension

Web extension that streamlines opening diffs in the viewer.
- [Firefox](https://addons.mozilla.org/en-US/firefox/addon/patch-roulette/)
- [Chrome](https://chromewebstore.google.com/detail/patch-roulette/feaaoepdocmiibjilhoahgldkaajfnhb)

## Development

### Setup

- Install [pnpm](https://pnpm.io/) and execute `pnpm install` to install the required dependencies.
- Install a JVM 21 or newer for the Gradle runtime (prefer a JDK to avoid extra downloads for a compiler).

### Testing

- The frontend can be tested with `pnpm run dev` in `/web`.

### Code Style

- The frontend uses ESLint and Prettier for code style. Run `pnpm run format` to reformat and `pnpm run lint` to check style.

<img src="https://papermc.io/assets/misc/namespace-oss-badge.svg?project=diff-viewer" alt="CI powered by namespace badge" />
