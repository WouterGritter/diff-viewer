<script lang="ts">
  import { MultiFileDiffViewerState } from "$lib/diff-viewer.svelte";
  import { Button, Popover } from "bits-ui";
  import ProgressBar from "$lib/components/progress-bar/ProgressBar.svelte";

  const viewer = MultiFileDiffViewerState.get();
  const resolver = viewer.patchResolver;

  let available = $derived(viewer.diffMetadata?.type === "github" && viewer.nestedPatchCount > 0);
</script>

{#if available && resolver.running}
  <Button.Root
    title={resolver.progress?.message ?? "Resolving patches…"}
    class="flex items-center gap-1 rounded-sm btn-fill-neutral border px-1 py-0.5 text-sm leading-none"
    onclick={() => {
      viewer.openDialog("resolve-patches");
    }}
  >
    <span class="iconify size-3.5 shrink-0 octicon--package-16" aria-hidden="true"></span>
    Resolving patches…
    <ProgressBar state={resolver.progressBar} class="h-1.5 w-16" />
  </Button.Root>
{:else if available && resolver.summary === null}
  <Button.Root
    title="Decompile the targeted jar and show what the .java.patch changes do to the actual source"
    class="flex items-center gap-1 rounded-sm btn-fill-neutral border px-1 py-0.5 text-sm leading-none"
    onclick={() => {
      viewer.openDialog("resolve-patches");
    }}
  >
    <span class="iconify size-3.5 shrink-0 octicon--package-16" aria-hidden="true"></span>
    Resolve patches
  </Button.Root>
{:else if resolver.summary !== null}
  {@const summary = resolver.summary}
  {@const stats = resolver.stats}
  <div class="flex items-center rounded-sm border text-sm leading-none">
    <Button.Root
      title={resolver.showResolved ? "Show the raw patch file diffs" : "Show the resolved source diffs"}
      class="flex items-center gap-1 rounded-l-sm btn-fill-neutral px-1 py-0.5"
      onclick={() => {
        viewer.setShowResolvedPatches(!resolver.showResolved);
      }}
    >
      <span class="iconify size-3.5 shrink-0 octicon--package-16" aria-hidden="true"></span>
      {resolver.showResolved ? "Resolved" : "Raw patches"}
    </Button.Root>
    <Popover.Root>
      <Popover.Trigger
        title="Patch resolution details"
        class="flex items-center rounded-r-sm btn-fill-neutral border-l px-1 py-0.5 data-[state=open]:bg-(--btn-hover)"
      >
        <span class="iconify size-3.5 octicon--info-16" aria-hidden="true"></span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class="z-50 mx-2 max-w-80 rounded-sm border bg-neutral px-3 py-2 text-sm shadow-sm">
          <p class="mb-1 font-semibold">Resolved against {summary.jarLabel}</p>
          {#if summary.layers.length > 1}
            <p class="mb-1 text-em-med">Patch layers: {summary.layers.join(" → ")}</p>
          {/if}
          <ul class="text-em-med">
            <li>{stats.ok} resolved</li>
            {#if stats.partial > 0}<li>{stats.partial} partially resolved (some hunks could not be placed)</li>{/if}
            {#if stats.unchanged > 0}<li>{stats.unchanged} without effective source change</li>{/if}
            {#if stats.skipped > 0}<li>{stats.skipped} skipped (class not in jar)</li>{/if}
            {#if stats.failed > 0}<li>{stats.failed} failed</li>{/if}
          </ul>
          <Button.Root
            class="mt-2 rounded-md btn-fill-neutral px-2 py-1"
            onclick={() => {
              viewer.openDialog("resolve-patches");
            }}>Resolve again…</Button.Root
          >
          <Popover.Arrow class="text-edge" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  </div>
{/if}
