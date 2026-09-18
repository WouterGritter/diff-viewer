<script lang="ts">
  import { type FileDetails } from "$lib/file-details";
  import type { ResolvedFile } from "$lib/patch-resolver/resolver";

  import DiffStats from "$lib/components/diff/DiffStats.svelte";
  import LabeledCheckbox from "$lib/components/LabeledCheckbox.svelte";
  import { MultiFileDiffViewerState } from "$lib/diff-viewer.svelte";
  import { GlobalOptions } from "$lib/global-options.svelte";
  import { Popover, Button } from "bits-ui";
  import { boolAttr } from "runed";
  import { tick } from "svelte";

  interface Props {
    file: FileDetails;
  }

  const viewer = MultiFileDiffViewerState.get();
  const globalOptions = GlobalOptions.get();
  let { file }: Props = $props();

  let popoverOpen = $state(false);

  async function showInFileTree() {
    viewer.layoutState.sidebarCollapsed = false;
    await tick();

    const fileTreeElement = document.getElementById("file-tree-file-" + file.index);
    if (fileTreeElement) {
      popoverOpen = false;
      viewer.fileTree.tree?.expandParents((node) => node.type === "file" && node.file === file);
      requestAnimationFrame(() => {
        fileTreeElement.focus();
      });
    }
  }

  let patchHeaderDiffOnly = $derived(file.type === "text" && file.patchHeaderDiffOnly);

  let resolved = $derived(viewer.patchResolver.get(file));
  let showingResolved = $derived(viewer.patchResolver.isShowingResolved(file));

  let { baseFileUrl, headFileUrl } = $derived.by(() => {
    if (viewer.diffMetadata?.type === "github") {
      const ghDetails = viewer.diffMetadata.details;
      return {
        baseFileUrl: `https://github.com/${ghDetails.owner}/${ghDetails.repo}/blob/${ghDetails.base}/${file.fromFile}`,
        headFileUrl: `https://github.com/${ghDetails.owner}/${ghDetails.repo}/blob/${ghDetails.head}/${file.toFile}`,
      };
    }
    return { baseFileUrl: undefined, headFileUrl: undefined };
  });

  function selectHeader() {
    viewer.scrollToFile(file.index, { autoExpand: false, smooth: true });
    viewer.setSelection(file, undefined);
  }

  let selected = $derived.by(() => {
    const sel = viewer.getSelection(file);
    return sel && sel.lines === undefined && sel.unresolvedLines === undefined;
  });
</script>

{#snippet fileName()}
  {#if file.fromFile === file.toFile}
    <span class="max-w-full overflow-hidden break-all">{file.toFile}</span>
  {:else}
    <span class="flex max-w-full flex-wrap items-center gap-0.5 overflow-hidden break-all">
      {file.fromFile}
      <span class="iconify inline-block text-em-med octicon--arrow-right-16" aria-label="renamed to"></span>
      {file.toFile}
    </span>
  {/if}
{/snippet}

{#snippet resolvedBadge(info: ResolvedFile)}
  {@const label = showingResolved
    ? info.status === "partial"
      ? "Partially resolved"
      : info.status === "unchanged"
        ? "No source change"
        : "Resolved"
    : info.details
      ? "Raw patch"
      : info.status === "skipped"
        ? "Not resolved"
        : "Failed"}
  <Popover.Root>
    <Popover.Trigger
      title="Patch resolution details"
      class={[
        "flex items-center gap-1 rounded-sm px-1.5 whitespace-nowrap",
        info.status === "partial" || info.status === "failed" ? "bg-yellow-500/20" : "bg-neutral-3",
      ]}
      onclick={(e) => e.stopPropagation()}
    >
      <span class="iconify size-3.5 shrink-0 octicon--package-16" aria-hidden="true"></span>
      {label}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content class="z-3 max-w-96 rounded-sm border bg-neutral px-3 py-2 text-sm shadow-sm">
        {#if info.className}
          <p class="mb-1 font-mono text-xs break-all">{info.className}.java</p>
        {/if}
        {#if info.notes.length > 0}
          <ul class="list-disc ps-4 text-em-med">
            {#each info.notes as note, i (i)}
              <li>{note}</li>
            {/each}
          </ul>
        {:else}
          <p class="text-em-med">All hunks applied exactly.</p>
        {/if}
        <Popover.Arrow class="text-edge" />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{/snippet}

{#snippet collapseToggle()}
  <button
    title={viewer.fileStates[file.index].collapsed ? "Expand file" : "Collapse file"}
    type="button"
    class="flex size-6 items-center justify-center rounded-sm btn-ghost p-0.5"
    onclick={(e) => {
      viewer.toggleCollapse(file.index);
      e.stopPropagation();
    }}
  >
    {#if viewer.fileStates[file.index].collapsed}
      <span
        aria-label="expand file"
        class="iconify size-4 shrink-0 text-em-med octicon--chevron-right-16"
        aria-hidden="true"
      ></span>
    {:else}
      <span
        aria-label="collapse file"
        class="iconify size-4 shrink-0 text-em-med octicon--chevron-down-16"
        aria-hidden="true"
      ></span>
    {/if}
  </button>
{/snippet}

{#snippet actionsPopover()}
  <Popover.Root bind:open={popoverOpen}>
    <Popover.Trigger
      title="Actions"
      class="flex size-6 items-center justify-center rounded-sm btn-ghost p-0.5 data-[state=open]:btn-ghost-visible"
      onclick={(e) => e.stopPropagation()}
    >
      <span class="iconify size-4 text-em-med octicon--kebab-horizontal-16" aria-hidden="true"></span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content
        class="z-3 flex flex-col overflow-hidden rounded-sm border bg-neutral text-sm shadow-sm select-none"
      >
        <Button.Root onclick={showInFileTree} class="btn-ghost px-2 py-1">Show in file tree</Button.Root>
        <LabeledCheckbox
          labelText="File viewed"
          bind:checked={
            () => viewer.fileStates[file.index].checked,
            () => {
              viewer.toggleChecked(file.index);
              popoverOpen = false;
            }
          }
        />
        {#if resolved?.details}
          <Button.Root
            class="btn-ghost px-2 py-1 text-left"
            onclick={() => {
              viewer.toggleResolvedPatch(file);
              popoverOpen = false;
            }}
          >
            {showingResolved ? "Show raw patch diff" : "Show resolved source diff"}
          </Button.Root>
        {/if}
        {#if baseFileUrl}
          <Button.Root href={baseFileUrl} target="_blank" rel="noopener noreferrer" class="btn-ghost px-2 py-1"
            >View file at base</Button.Root
          >
        {/if}
        {#if headFileUrl}
          <Button.Root href={headFileUrl} target="_blank" rel="noopener noreferrer" class="btn-ghost px-2 py-1"
            >View file at head</Button.Root
          >
        {/if}
        <Popover.Arrow class="text-edge" />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{/snippet}

<div
  id="file-header-{file.index}"
  class={[
    "sticky top-0 z-10 flex flex-row items-center gap-2 border-b bg-neutral px-2 py-1 text-sm shadow-sm",
    "focus-and-selected-styles focus:outline-none",
  ]}
  tabindex={0}
  role="button"
  onclick={() => selectHeader()}
  onkeyup={(event) => event.key === "Enter" && selectHeader()}
  data-selected={boolAttr(selected)}
>
  {#if file.type === "text"}
    <DiffStats brief add={file.addedLines} remove={file.removedLines} />
  {/if}
  {@render fileName()}
  <div class="ms-0.5 ml-auto flex items-center gap-1">
    {#if patchHeaderDiffOnly}
      <span class="rounded-sm bg-neutral-3 px-1.5">Patch-header-only diff</span>
    {/if}
    {#if resolved && viewer.patchResolver.showResolved}
      {@render resolvedBadge(resolved)}
    {/if}
    {@render actionsPopover()}
    {#if !patchHeaderDiffOnly || !globalOptions.omitPatchHeaderOnlyHunks || file.type === "image"}
      {@render collapseToggle()}
    {/if}
  </div>
</div>

<style>
  .focus-and-selected-styles {
    &:focus {
      box-shadow:
        var(--tw-shadow),
        inset 0 0 0 2px color-mix(in srgb, var(--color-focus) 50%, transparent);
    }
    &[data-selected] {
      box-shadow:
        var(--tw-shadow),
        inset 4px 0 0 0 var(--color-focus);
    }
    &:focus[data-selected] {
      box-shadow:
        var(--tw-shadow),
        inset 0 0 0 2px color-mix(in srgb, var(--color-focus) 50%, transparent),
        inset 4px 0 0 0 var(--color-focus);
    }
  }
</style>
