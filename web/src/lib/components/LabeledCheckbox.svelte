<script lang="ts">
  import { Checkbox, Label, useId } from "bits-ui";

  interface Props {
    labelText: string;
    checked: boolean;
    disabled?: boolean;
  }

  let { labelText, checked = $bindable(), disabled = false }: Props = $props();

  let labelId = useId();
  let checkboxId = useId();
</script>

<Checkbox.Root
  id={checkboxId}
  aria-labelledby={labelId}
  bind:checked
  {disabled}
  class="flex cursor-pointer items-center justify-between gap-2 btn-ghost px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
>
  {#snippet children({ checked })}
    <Label.Root id={labelId} for={checkboxId} class="cursor-[inherit] text-left">
      {labelText}
    </Label.Root>
    <div
      class="relative size-5 shrink-0 rounded-sm border bg-neutral transition-colors ease-in-out data-[state=checked]:bg-blue-500"
      data-state={checked ? "checked" : "unchecked"}
    >
      <span
        class="absolute top-1/2 left-1/2 iconify size-4 -translate-x-1/2 -translate-y-1/2 bg-white opacity-0 transition-opacity ease-in-out octicon--check-16 data-[state=checked]:opacity-100"
        aria-hidden="true"
        data-state={checked ? "checked" : "unchecked"}
      ></span>
    </div>
  {/snippet}
</Checkbox.Root>
