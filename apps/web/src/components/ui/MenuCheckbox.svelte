<script lang="ts">
  import type { Snippet } from 'svelte';

  // One on/off row in an OverflowMenu. The menu owns the focus, so the row is
  // never a tab stop of its own.
  interface Props {
    checked: boolean;
    children: Snippet;
  }
  let { checked = $bindable(), children }: Props = $props();
</script>

<button
  type="button"
  role="menuitemcheckbox"
  aria-checked={checked}
  tabindex="-1"
  class="focus-ring-inset flex min-h-11 w-full items-center gap-2 rounded px-3 text-left text-sm
         hover:bg-accent-soft focus:bg-accent-soft"
  onclick={() => (checked = !checked)}
>
  <svg
    class="size-4 shrink-0 text-accent {checked ? '' : 'invisible'}"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
  <span class="min-w-0 flex-1">{@render children()}</span>
</button>
