<script lang="ts">
  import { type FileDetails } from "$lib/file-details";
  import type { ResolvedInfo } from "$lib/components/patch-resolver/index.svelte";

  import DiffStats from "$lib/components/diff/DiffStats.svelte";
  import LabeledCheckbox from "$lib/components/LabeledCheckbox.svelte";
  import { MultiFileDiffViewerState } from "$lib/diff-viewer.svelte";
  import { GlobalOptions } from "$lib/global-options.svelte";
  import { Popover, Button, Checkbox, Tooltip } from "bits-ui";
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
  let hasContent = $derived(!patchHeaderDiffOnly || !globalOptions.omitPatchHeaderOnlyHunks);

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

{#snippet resolvedBadge(info: ResolvedInfo)}
  {@const status = info.kind === "entry" ? info.entry.status : info.file.status}
  {@const notes = info.kind === "entry" ? [...info.entry.notes, ...info.file.notes] : info.file.notes}
  {@const label =
    info.kind === "entry"
      ? status === "partial"
        ? "Partially resolved"
        : status === "unchanged"
          ? "No source change"
          : "Resolved"
      : viewer.patchResolver.hasResolvedDiff(file)
        ? "Raw patch"
        : status === "unchanged"
          ? "No source change"
          : status === "skipped"
            ? "Not resolved"
            : "Failed"}
  {@const badgeClass = [
    "flex items-center gap-1 rounded-sm px-1.5 whitespace-nowrap",
    status === "partial" || status === "failed" ? "bg-yellow-500/20" : "bg-neutral-3",
  ]}
  {#snippet badgeContent()}
    <span class="iconify size-3.5 shrink-0 octicon--package-16" aria-hidden="true"></span>
    {label}
  {/snippet}
  {#snippet details()}
    {#if info.kind === "entry"}
      <p class="mb-1 font-mono text-xs break-all">{info.entry.target}</p>
    {/if}
    {#if notes.length > 0}
      <ul class="list-disc ps-4 text-em-med">
        {#each notes as note, i (i)}
          <li>{note}</li>
        {/each}
      </ul>
    {:else}
      <p class="text-em-med">All hunks applied exactly.</p>
    {/if}
  {/snippet}
  {#if viewer.patchResolver.hasResolvedDiff(file)}
    <!-- Clicking switches between the resolved and raw diff, the details show on hover instead -->
    <Tooltip.Root>
      <Tooltip.Trigger
        class={[badgeClass, "cursor-pointer hover:brightness-95 dark:hover:brightness-125"]}
        aria-label={showingResolved ? "Show raw patch diff" : "Show resolved source diff"}
        onclick={(e) => {
          e.stopPropagation();
          viewer.toggleResolvedPatch(file);
        }}
        onkeyup={(e) => e.stopPropagation()}
      >
        {@render badgeContent()}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content class="z-50 max-w-96 rounded-sm border bg-neutral px-3 py-2 text-sm shadow-sm">
          {@render details()}
          <p class="mt-1 text-xs text-em-med">
            Click to show the {showingResolved ? "raw patch" : "resolved source"} diff
          </p>
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  {:else}
    <Popover.Root>
      <Popover.Trigger title="Patch resolution details" class={badgeClass} onclick={(e) => e.stopPropagation()}>
        {@render badgeContent()}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="z-3 max-w-96 rounded-sm border bg-neutral px-3 py-2 text-sm shadow-sm">
          {@render details()}
          <Popover.Arrow class="text-edge" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  {/if}
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

{#snippet viewedToggle()}
  <Checkbox.Root
    title={viewer.fileStates[file.index].checked ? "Mark file as not viewed" : "Mark file as viewed"}
    bind:checked={() => viewer.fileStates[file.index].checked, () => viewer.toggleChecked(file.index, true)}
    class="flex cursor-pointer items-center gap-1 rounded-sm btn-ghost px-1.5 whitespace-nowrap"
    onclick={(e) => e.stopPropagation()}
    onkeyup={(e) => e.stopPropagation()}
  >
    {#snippet children({ checked })}
      <span
        class="relative size-3.5 shrink-0 rounded-sm border bg-neutral transition-colors ease-in-out data-[state=checked]:bg-blue-500"
        data-state={checked ? "checked" : "unchecked"}
      >
        <span
          class="absolute top-1/2 left-1/2 iconify size-3 -translate-x-1/2 -translate-y-1/2 bg-white opacity-0 transition-opacity ease-in-out octicon--check-16 data-[state=checked]:opacity-100"
          aria-hidden="true"
          data-state={checked ? "checked" : "unchecked"}
        ></span>
      </span>
      Viewed
    {/snippet}
  </Checkbox.Root>
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
        {#if hasContent}
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
        {/if}
        {#if file.type === "text" && hasContent && viewer.contextExpansion.canExpand(file)}
          <Button.Root
            class="btn-ghost px-2 py-1 text-left"
            disabled={viewer.contextExpansion.isLoading(file)}
            onclick={() => {
              viewer.contextExpansion.expandAll(file);
              popoverOpen = false;
            }}
          >
            Expand all lines
          </Button.Root>
        {/if}
        {#if resolved && viewer.patchResolver.hasResolvedDiff(file)}
          <LabeledCheckbox
            labelText="Show resolved diff"
            bind:checked={
              () => showingResolved,
              () => {
                viewer.toggleResolvedPatch(file);
                popoverOpen = false;
              }
            }
          />
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
    {#if hasContent}
      {@render viewedToggle()}
    {/if}
    {@render actionsPopover()}
    {#if hasContent}
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
