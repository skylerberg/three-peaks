<script lang="ts">
  import Thumbnail from './Thumbnail.svelte';
  import Button from './ui/Button.svelte';

  // What a screen hands over per card. `version` pins the artwork the way
  // Thumbnail's own does, so a history screen shows what a run left rather than
  // what the file holds now, and `note` is whatever that screen would have said
  // beside the row -- a copy count here, a version and a tombstone there.
  interface ViewerCard {
    id: string;
    fileId: string;
    title: string;
    version?: number;
    note?: string;
  }

  interface Props {
    cards: readonly ViewerCard[];
    openId: string | null;
  }
  let { cards, openId = $bindable(null) }: Props = $props();

  const uid = $props.id();

  // The open card is named by id rather than by position: a save or a realtime
  // event replaces the whole list, and an index would then be pointing at
  // whatever moved into that slot. A card that leaves the list closes the
  // viewer instead of silently becoming its neighbour.
  const index = $derived(cards.findIndex((card) => card.id === openId));
  const card = $derived(index === -1 ? null : cards[index]);
  const open = $derived(card !== null);

  let panel = $state<HTMLElement | null>(null);

  function close(): void {
    openId = null;
  }

  // Stops at the ends rather than wrapping, which is what the reorder buttons
  // on a deck's own rows do at the same two places.
  function step(by: number): void {
    const next = index + by;
    if (next < 0 || next >= cards.length) return;
    openId = cards[next].id;
  }

  const FOCUSABLE = 'a[href], button:not([disabled])';

  // Tab is the one key a modal has to take away from the page behind it: the
  // overlay hides that page from the pointer and from nothing else.
  function trapTab(event: KeyboardEvent): void {
    const node = panel;
    if (!node) return;
    const stops = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (stops.length === 0) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;
    // The panel itself is what the viewer opens focused on, and a Tab from
    // there already lands inside it; only the two edges have to turn around.
    if (event.shiftKey && (active === first || active === node)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // On the window rather than on the panel: clicking the artwork leaves focus
  // on nothing in particular, and keys answered only by the panel would stop
  // working the moment somebody did that.
  function onKeydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === 'Tab') {
      trapTab(event);
      return;
    }
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') step(1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') step(-1);
    else return;
    event.preventDefault();
  }

  // Everything that is true only while it is open, in one place so that
  // closing, navigating away and the card leaving the list all undo it
  // identically. Focus comes back to whatever opened the viewer -- a row a
  // person was halfway down, which is otherwise theirs to find again.
  $effect(() => {
    if (!open) return;
    const root = document.documentElement;
    const scroll = root.style.overflow;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.style.overflow = 'hidden';
    panel?.focus();
    return () => {
      root.style.overflow = scroll;
      opener?.focus();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if card}
  <!-- The backdrop closes on a click of its own, never on one that reached it
       from the panel. -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) close();
    }}
  >
    <div
      bind:this={panel}
      role="dialog"
      aria-modal="true"
      aria-labelledby="{uid}-title"
      tabindex="-1"
      class="focus-ring flex max-h-full w-full max-w-3xl flex-col gap-3 overflow-y-auto rounded-md
             border border-edge bg-surface-raised p-4 shadow-lg"
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 id="{uid}-title" class="truncate text-lg font-semibold">{card.title}</h2>
          <p class="text-sm text-muted">
            {index + 1} of {cards.length}{card.note ? ` · ${card.note}` : ''}
          </p>
        </div>
        <Button variant="secondary" onclick={close}>Close</Button>
      </div>

      <Thumbnail
        fileId={card.fileId}
        version={card.version}
        class="h-[60vh] w-full"
        fit="contain"
        alt={card.title}
      />

      <div class="flex items-center justify-between gap-2">
        <Button variant="secondary" disabled={index === 0} onclick={() => step(-1)}>Previous</Button
        >
        <Button variant="secondary" disabled={index === cards.length - 1} onclick={() => step(1)}>
          Next
        </Button>
      </div>
    </div>
  </div>
{/if}
