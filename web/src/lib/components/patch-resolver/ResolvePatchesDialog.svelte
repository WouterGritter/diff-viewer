<script lang="ts">
  import { Button, Dialog, RadioGroup } from "bits-ui";
  import { MultiFileDiffViewerState } from "$lib/diff-viewer.svelte";
  import InfoPopup from "$lib/components/InfoPopup.svelte";
  import LabeledCheckbox from "$lib/components/LabeledCheckbox.svelte";
  import ProgressBar from "$lib/components/progress-bar/ProgressBar.svelte";
  import { fetchMinecraftVersions, isUnobfuscatedVersion } from "$lib/patch-resolver/jar-source";
  import { getGithubUsername, loginWithGithub } from "$lib/github-auth.svelte";
  import { watch } from "runed";

  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  const viewer = MultiFileDiffViewerState.get();
  const resolver = viewer.patchResolver;

  let github = $derived(viewer.diffMetadata?.type === "github" ? viewer.diffMetadata.details : null);

  // Version suggestions for the datalist; only fetched once the dialog is used
  let versionIds: string[] = $state([]);
  watch(
    () => open,
    (isOpen) => {
      if (!isOpen) return;
      if (github) resolver.detectVersion(github);
      if (versionIds.length === 0) {
        fetchMinecraftVersions()
          .then((versions) => {
            versionIds = versions.filter(isUnobfuscatedVersion).map((v) => v.id);
          })
          .catch((e) => console.info("Could not fetch Minecraft versions", e));
      }
    },
  );

  async function submit() {
    if (!github) return;
    const success = await resolver.run(github, viewer.rawFileDetails);
    if (success) {
      viewer.clearSelection();
      open = false;
    }
  }
</script>

<!-- Closing the dialog keeps a run going, its progress is shown next to the diff stats -->
<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 flex max-h-svh w-2xl max-w-full -translate-x-1/2 -translate-y-1/2 flex-col rounded-sm border bg-neutral shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-[95%]"
    >
      <header class="flex shrink-0 flex-row items-center justify-between rounded-t-sm border-b bg-neutral-2 p-4">
        <Dialog.Title class="text-xl font-semibold">Resolve Patches Against Source</Dialog.Title>
        <Dialog.Close
          title="Close dialog"
          class="flex size-6 items-center justify-center rounded-sm btn-ghost text-em-med"
        >
          <span class="iconify octicon--x-16" aria-hidden="true"></span>
        </Dialog.Close>
      </header>

      <form
        class="flex grow flex-col gap-4 overflow-y-auto p-4"
        onsubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p class="text-sm text-em-med">
          This diff contains {viewer.nestedPatchCount} patch {viewer.nestedPatchCount === 1 ? "file" : "files"}
          (<code class="rounded-sm bg-neutral-2 px-1 py-0.5">.java.patch</code> or feature patches) that modify Java source
          which is not part of the repository. The jar those patches target can be downloaded and decompiled locally in your
          browser (using Vineflower), and the repository's other patches applied in order, to show what the change actually
          does to the source, with surrounding code for context. Nothing is uploaded or redistributed; the jar is fetched
          straight from its origin into your browser.
        </p>
        <p class="text-sm text-em-med">
          The patches are applied using fuzzy matching, since the decompiled output can differ slightly from the source
          they were created against. Files where hunks could not be placed are marked, and their raw patch diff can
          still be viewed.
        </p>

        {#if !getGithubUsername()}
          <div class="flex flex-col items-start gap-2 rounded-md border bg-neutral-2 p-3">
            <span class="flex gap-2 text-sm text-em-med">
              <span class="mt-0.5 iconify shrink-0 text-em-med octicon--info-16" aria-hidden="true"></span>
              <span>
                Resolving reads the repository's other patch files from the GitHub API, which is rate limited to 60
                requests per hour for signed out users. Signing in is recommended, as a single run can exceed that on
                repositories with many patches.
              </span>
            </span>
            <Button.Root
              type="button"
              class="flex flex-row items-center gap-2 rounded-md btn-fill-neutral px-2 py-1"
              onclick={loginWithGithub}
            >
              <span class="iconify shrink-0 text-em-med octicon--sign-in-16"></span>
              Sign in to GitHub
            </Button.Root>
          </div>
        {/if}

        <section class="flex flex-col gap-2">
          <header class="flex items-center gap-1 font-semibold">
            Source jar
            <InfoPopup>
              Minecraft versions are downloaded from Mojang's servers (server jar). Only versions from 26.1-snapshot-1
              onwards are supported, as earlier versions are obfuscated. Alternatively, provide a direct URL to any jar;
              the server hosting it must allow cross-origin requests.
            </InfoPopup>
          </header>
          <RadioGroup.Root bind:value={resolver.sourceKind} class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <RadioGroup.Item
                value="minecraft"
                id="jar-source-minecraft"
                class="flex size-4 shrink-0 items-center justify-center rounded-full border bg-neutral data-[state=checked]:border-4 data-[state=checked]:border-blue-500"
              />
              <label for="jar-source-minecraft" class="shrink-0">Minecraft version</label>
              <input
                type="text"
                list="minecraft-version-list"
                placeholder={resolver.detectedVersion ?? "e.g. 26.2"}
                class="min-w-0 grow rounded-md border px-2 py-1 inset-shadow-xs ring-focus focus:outline-none focus-visible:ring-2 disabled:opacity-50"
                disabled={resolver.sourceKind !== "minecraft"}
                bind:value={resolver.minecraftVersion}
                onfocus={() => (resolver.sourceKind = "minecraft")}
              />
              <datalist id="minecraft-version-list">
                {#each versionIds as id (id)}
                  <option value={id}></option>
                {/each}
              </datalist>
            </div>
            {#if resolver.detectedVersion}
              <span class="ms-6 text-sm text-em-med">
                Detected from the repository: <code class="rounded-sm bg-neutral-2 px-1 py-0.5"
                  >{resolver.detectedVersion}</code
                >
              </span>
            {/if}
            <div class="flex items-center gap-2">
              <RadioGroup.Item
                value="url"
                id="jar-source-url"
                class="flex size-4 shrink-0 items-center justify-center rounded-full border bg-neutral data-[state=checked]:border-4 data-[state=checked]:border-blue-500"
              />
              <label for="jar-source-url" class="shrink-0">Jar URL</label>
              <input
                type="url"
                placeholder="https://example.com/some.jar"
                class="min-w-0 grow rounded-md border px-2 py-1 inset-shadow-xs ring-focus focus:outline-none focus-visible:ring-2 disabled:opacity-50"
                disabled={resolver.sourceKind !== "url"}
                bind:value={resolver.jarUrl}
                onfocus={() => (resolver.sourceKind = "url")}
              />
            </div>
          </RadioGroup.Root>
        </section>

        <section class="flex flex-col gap-1">
          <LabeledCheckbox
            labelText="I own a license for the software being decompiled (e.g. Minecraft: Java Edition) and agree to its terms of use (EULA)"
            bind:checked={resolver.licenseAccepted}
          />
        </section>

        {#if resolver.running}
          <div class="flex flex-col gap-2 rounded-md border bg-neutral-2 p-3">
            <span class="text-sm">{resolver.progress?.message ?? "Working…"}</span>
            <ProgressBar state={resolver.progressBar} class="h-2 w-full" />
          </div>
        {/if}

        <div class="flex items-center gap-2">
          {#if resolver.running}
            <Button.Root
              type="button"
              class="rounded-md btn-fill-danger px-2 py-1"
              onclick={() => {
                resolver.cancel();
              }}>Cancel</Button.Root
            >
          {:else}
            <Button.Root type="submit" class="rounded-md btn-fill-primary px-2 py-1" disabled={!github}>
              Decompile and Resolve
            </Button.Root>
          {/if}
          {#if !github}
            <span class="text-sm text-em-med">Only available for diffs loaded from GitHub.</span>
          {/if}
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
