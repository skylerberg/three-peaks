<script lang="ts">
  import { type Snippet, tick } from 'svelte';

  // A "⋯" button holding the options too minor to earn a place on the screen.
  // It follows the ARIA menu button pattern: opening moves the focus into the
  // menu, the arrows walk it, and Escape hands the focus back to the button.
  // Its items are `MenuCheckbox` rows, or anything else carrying a menuitem
  // role and tabindex -1; activating one closes the menu.
  interface Props {
    label: string;
    children: Snippet;
  }
  let { label, children }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLElement | null>(null);
  let trigger = $state<HTMLButtonElement | null>(null);
  let menu = $state<HTMLElement | null>(null);
  const uid = $props.id();
  const menuId = `${uid}-menu`;

  function items(): HTMLElement[] {
    return menu ? [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')] : [];
  }

  async function show(focus: 'first' | 'last') {
    open = true;
    await tick();
    const all = items();
    (focus === 'first' ? all[0] : all.at(-1))?.focus();
  }

  function hide(returnFocus: boolean) {
    open = false;
    if (returnFocus) trigger?.focus();
  }

  function onTriggerKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      void show(event.key === 'ArrowDown' ? 'first' : 'last');
    }
  }

  function onMenuKeydown(event: KeyboardEvent) {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const moveTo = (index: number) => {
      event.preventDefault();
      all[(index + all.length) % all.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        return moveTo(at + 1);
      case 'ArrowUp':
        return moveTo(at - 1);
      case 'Home':
        return moveTo(0);
      case 'End':
        return moveTo(all.length - 1);
      case 'Escape':
        event.preventDefault();
        return hide(true);
      // Tab leaves the menu the way it leaves anything else; the focus goes on
      // to whatever follows the button rather than back to it.
      case 'Tab':
        return hide(false);
    }
  }

  function onMenuClick(event: MouseEvent) {
    if ((event.target as Element).closest('[role^="menuitem"]')) hide(true);
  }

  function onWindowPointerdown(event: PointerEvent) {
    if (open && root && !root.contains(event.target as Node)) hide(false);
  }
</script>

<svelte:window onpointerdown={onWindowPointerdown} />

<div class="relative" bind:this={root}>
  <button
    type="button"
    bind:this={trigger}
    class="focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-md
           text-muted hover:bg-accent-soft hover:text-ink"
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={open ? menuId : undefined}
    onclick={() => (open ? hide(false) : void show('first'))}
    onkeydown={onTriggerKeydown}
  >
    <svg class="size-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.75" />
      <circle cx="12" cy="12" r="1.75" />
      <circle cx="19" cy="12" r="1.75" />
    </svg>
  </button>

  {#if open}
    <div
      id={menuId}
      bind:this={menu}
      role="menu"
      tabindex="-1"
      aria-label={label}
      class="absolute top-full right-0 z-40 mt-1 flex min-w-56 flex-col rounded-md border
             border-edge bg-surface-raised p-1 shadow-lg"
      onkeydown={onMenuKeydown}
      onclick={onMenuClick}
    >
      {@render children()}
    </div>
  {/if}
</div>
