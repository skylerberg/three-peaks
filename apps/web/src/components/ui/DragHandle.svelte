<script lang="ts">
  import { dragHandle } from 'svelte-dnd-action';

  // The grip a row is dragged by. The action owns the rest of it: `role`,
  // `tabindex` and the grab cursor are set on this element as the drag starts
  // and stops, and the keyboard half -- space or enter to lift, the arrows to
  // move, escape to put it back -- hangs off the same listeners.
  interface Props {
    label: string;
  }
  let { label }: Props = $props();
</script>

<span
  use:dragHandle
  aria-label={label}
  class="focus-ring flex min-h-11 w-8 shrink-0 touch-none items-center justify-center rounded text-muted select-none"
>
  <svg class="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="9" cy="6" r="1.5" />
    <circle cx="15" cy="6" r="1.5" />
    <circle cx="9" cy="12" r="1.5" />
    <circle cx="15" cy="12" r="1.5" />
    <circle cx="9" cy="18" r="1.5" />
    <circle cx="15" cy="18" r="1.5" />
  </svg>
</span>
