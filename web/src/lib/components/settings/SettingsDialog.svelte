<script lang="ts">
  import SettingsGroup from "./SettingsGroup.svelte";
  import { Label, Dialog, Button } from "bits-ui";
  import SimpleRadioGroup from "$lib/components/settings/SimpleRadioGroup.svelte";
  import { GlobalOptions } from "$lib/global-options.svelte";
  import { getGlobalTheme, setGlobalTheme } from "$lib/theme.svelte";
  import LabeledCheckbox from "../LabeledCheckbox.svelte";

  import ShikiThemeSelector from "./ShikiThemeSelector.svelte";
  import DiffFilterDialog from "../diff-filtering/DiffFilterDialog.svelte";
  import { watch } from "runed";
  import { MultiFileDiffViewerState } from "$lib/diff-viewer.svelte";
  import { getGithubAvatarUrl, getGithubUsername, loginWithGithub } from "$lib/github-auth.svelte";
  interface Props {
    open?: boolean;
  }

  let { open = $bindable(false) }: Props = $props();

  const globalOptions = GlobalOptions.get();
  const viewer = MultiFileDiffViewerState.get();
  const resolver = viewer.patchResolver;
  let autoResolveAvailable = $derived(viewer.autoResolvePatchesAvailable);

  let defaultFiltersDialogOpen = $state(false);
  watch(
    () => open,
    (v) => {
      if (!v) {
        // Close child dialogs when this dialog is closed
        defaultFiltersDialogOpen = false;
      }
    },
  );
</script>

{#snippet globalThemeSetting()}
  <SettingsGroup title="Theme">
    <div class="px-2 py-1">
      <SimpleRadioGroup
        values={["light", "dark", "auto"]}
        bind:value={getGlobalTheme, setGlobalTheme}
        aria-label="Select theme"
      />
    </div>
  </SettingsGroup>
{/snippet}

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
    />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 flex max-h-svh w-md max-w-full -translate-x-1/2 -translate-y-1/2 flex-col rounded-sm border bg-neutral shadow-md data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-[95%]"
    >
      <header class="flex shrink-0 flex-row items-center justify-between rounded-t-sm border-b bg-neutral-2 p-4">
        <Dialog.Title class="text-xl font-semibold">Settings</Dialog.Title>
        <Dialog.Close
          title="Close dialog"
          class="flex size-6 items-center justify-center rounded-sm btn-ghost text-em-med"
        >
          <span class="iconify octicon--x-16" aria-hidden="true"></span>
        </Dialog.Close>
      </header>

      <div class="space-y-4 overflow-y-auto p-4">
        {@render globalThemeSetting()}
        <SettingsGroup title="Syntax Highlighting">
          <LabeledCheckbox labelText="Enable" bind:checked={globalOptions.syntaxHighlighting} />
          <ShikiThemeSelector mode="light" bind:value={globalOptions.syntaxHighlightingThemeLight} />
          <ShikiThemeSelector mode="dark" bind:value={globalOptions.syntaxHighlightingThemeDark} />
        </SettingsGroup>
        <SettingsGroup title="Patch Resolver">
          <LabeledCheckbox
            labelText="I own a license for the software being decompiled (e.g. Minecraft: Java Edition) and agree to its terms of use (EULA)"
            bind:checked={resolver.licenseAccepted}
          />
          <LabeledCheckbox
            labelText="Automatically resolve patches when opening a diff"
            bind:checked={globalOptions.autoResolvePatches}
            disabled={!autoResolveAvailable}
          />
          {#if !autoResolveAvailable}
            <p class="flex gap-2 px-2 py-1 text-sm text-em-med">
              <span class="mt-0.5 iconify shrink-0 octicon--alert-16" aria-hidden="true"></span>
              <span>
                Automatic resolving requires confirming the license above and signing in to GitHub, as a single run can
                exceed the API rate limit for signed out users.
              </span>
            </p>
          {/if}
          <div class="flex items-center gap-2 px-2 py-1">
            {#if getGithubUsername()}
              {@const username = getGithubUsername()!}
              <img
                src={getGithubAvatarUrl(username)}
                alt="GitHub Profile Picture of {username}"
                class="size-6 shrink-0 rounded-full border shadow-xs"
              />
              <span>Signed in to GitHub as {username}</span>
            {:else}
              <Button.Root
                class="flex w-fit flex-row items-center gap-2 rounded-md btn-fill-neutral px-2 py-1"
                onclick={loginWithGithub}
              >
                <span class="iconify shrink-0 text-em-med octicon--sign-in-16"></span>
                Sign in to GitHub
              </Button.Root>
            {/if}
          </div>
        </SettingsGroup>
        <SettingsGroup title="Viewed Files">
          <div class="flex items-center justify-between gap-2 px-2 py-1">
            <span class="text-em-med">
              Remembering {viewer.viewedFiles.count.toLocaleString()}
              {viewer.viewedFiles.count === 1 ? "file" : "files"}
            </span>
            <Button.Root
              class="w-fit shrink-0 rounded-sm btn-fill-neutral px-2 py-1"
              disabled={viewer.viewedFiles.count === 0}
              onclick={() => viewer.viewedFiles.clear()}
            >
              Clear
            </Button.Root>
          </div>
        </SettingsGroup>
        <SettingsGroup title="Misc.">
          <LabeledCheckbox labelText="Concise nested diffs" bind:checked={globalOptions.omitPatchHeaderOnlyHunks} />
          <LabeledCheckbox labelText="Word diffs" bind:checked={globalOptions.wordDiffs} />
          <LabeledCheckbox labelText="Line wrapping" bind:checked={globalOptions.lineWrap} />
          <div class="flex justify-between px-2 py-1">
            <Label.Root id="sidebarLocationLabel" for="sidebarLocation">Sidebar location</Label.Root>
            <SimpleRadioGroup
              id="sidebarLocation"
              aria-labelledby="sidebarLocationLabel"
              values={["left", "right"]}
              bind:value={globalOptions.sidebarLocation}
            />
          </div>
          <Button.Root
            class="w-fit rounded-sm btn-fill-neutral px-2 py-1"
            onclick={() => {
              defaultFiltersDialogOpen = true;
            }}
          >
            Edit Default Filters
          </Button.Root>
        </SettingsGroup>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<DiffFilterDialog mode="defaults" bind:open={defaultFiltersDialogOpen} instance={globalOptions.defaultFilters} />
