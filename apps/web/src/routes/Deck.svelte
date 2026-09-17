<script lang="ts">
  import {
    CARD_PRESETS,
    DECK_QUANTITY_LIMITS,
    MODEL_LIMITS,
    PRINT_DPI,
    cardPreset,
    deckCardSize,
    effectiveDpi,
    matchingCardPreset,
  } from '@three-peaks/shared';
  import type { components } from '@three-peaks/shared/api';
  import FilePicker from '../components/decks/FilePicker.svelte';
  import CardViewer from '../components/CardViewer.svelte';
  import Thumbnail from '../components/Thumbnail.svelte';
  import Button from '../components/ui/Button.svelte';
  import Input from '../components/ui/Input.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import { ApiError, api, assertOk } from '../api/client.ts';
  import { deckImports } from '../lib/deckImports.svelte.ts';
  import { type DeckCard, decks } from '../lib/decks.svelte.ts';
  import { files } from '../lib/files.svelte.ts';
  import { realtime } from '../lib/realtime.svelte.ts';
  import { link } from '../lib/router.svelte.ts';
  import { apiMessage } from '../lib/session.svelte.ts';
  import { toasts } from '../lib/toasts.svelte.ts';

  interface Props {
    projectId: string;
    deckId: string;
  }
  let { projectId, deckId }: Props = $props();

  type File = components['schemas']['File'];

  let error = $state<string | null>(null);
  let canEdit = $state(false);
  let picking = $state<'cards' | null>(null);
  let uploading = $state(false);
  let discarding = $state(false);
  let name = $state('');
  let backFile = $state<File | null>(null);
  let viewing = $state<string | null>(null);

  const deck = $derived(decks.deck);
  const cards = $derived(decks.cards);
  const [minQuantity, maxQuantity] = DECK_QUANTITY_LIMITS;
  const limits = MODEL_LIMITS.card;
  const uid = $props.id();

  const presetId = $derived(deck ? (matchingCardPreset(deckCardSize(deck))?.id ?? '') : '');
  const totalCopies = $derived(cards.reduce((sum, card) => sum + card.quantity, 0));
  // Scoped to this deck: the route block is not keyed, so walking from one
  // deck to another swaps these props on the screen already mounted and the
  // row read for the deck just left would otherwise be drawn under this name.
  const binding = $derived(deckImports.bindingDeckId === deckId ? deckImports.binding : null);
  const openRunId = $derived(binding?.open_run_id ?? null);
  const importStatus = $derived.by(() => {
    // Nothing at all until the row has landed, rather than "never imported
    // into" for the moment before the answer arrives.
    if (deckImports.loadingBinding || deckImports.bindingDeckId !== deckId) return null;
    if (binding?.source_label) return `Last imported from ${binding.source_label}.`;
    // Nothing to set up: the artwork lands in this deck, so there is nowhere
    // else it could go and nothing to choose first.
    return 'Never imported into.';
  });

  $effect(() => {
    const id = deckId;
    error = null;
    void decks.loadDeck(id).catch((caught: unknown) => {
      error =
        caught instanceof ApiError && caught.status === 404
          ? 'That deck does not exist, or you do not have access to it.'
          : apiMessage(caught);
    });
  });

  // The name input is a draft the visitor is typing into, so it is seeded from
  // the deck rather than bound to it -- binding would rewrite what they are
  // halfway through whenever a realtime event reloaded the row.
  $effect(() => {
    const loaded = decks.deck;
    if (loaded && loaded.id === deckId) name = loaded.name;
  });

  $effect(() => {
    const id = projectId;
    api
      .GET('/api/projects/{id}', { params: { path: { id } } })
      .then((result) => {
        canEdit = assertOk(result).role === 'editor';
      })
      .catch(() => {
        canEdit = false;
      });
  });

  // Value-compared, for the reason Thumbnail.svelte spells out at its own: the
  // save replaces decks.deck, so reading the field straight re-read the same
  // row on every copy count edit.
  const backFileId = $derived(decks.deck?.back_file_id ?? null);

  const backChoices = $derived(
    cards.filter((card) => card.file.deleted_at === null || card.file_id === backFileId)
  );

  // The deck's own order, so the arrow keys in the viewer walk the list the
  // screen is showing.
  const viewerCards = $derived(
    cards.map((card) => ({
      id: card.file_id,
      fileId: card.file_id,
      title: card.file.filename,
      note: cardNote(card),
    }))
  );

  // The back is named by id only, so its row has to be read to draw it.
  $effect(() => {
    const id = backFileId;
    if (!id) {
      backFile = null;
      return;
    }
    let stale = false;
    api
      .GET('/api/files/{id}', { params: { path: { id } } })
      .then((result) => {
        if (!stale) backFile = assertOk(result);
      })
      .catch(() => {
        if (!stale) backFile = null;
      });
    return () => {
      stale = true;
    };
  });

  $effect(() => {
    const id = projectId;
    realtime.subscribe(id);
    // Nothing here reads anything back: every event carries what it changed.
    // That is also why there is no coalescing left -- an import publishing one
    // event per page costs this screen no requests at all.
    const off = realtime.on((event) => {
      if (event.project_id !== id) return;
      switch (event.type) {
        case 'deck_updated':
          // Another deck in this project moving says nothing about this one.
          if (event.data.deck.id !== deckId) return;
          decks.applyDeckUpdate(event.data.deck, event.data.cards);
          return;
        case 'deck_deleted':
          if (event.data.id !== deckId) return;
          error = 'That deck has been deleted.';
          return;
        // A card embeds its file row, so these reach the cards on screen even
        // though none of them is about the deck.
        case 'file_updated':
        case 'file_deleted':
          decks.applyCardFile(event.data);
          return;
        case 'file_version_created':
          decks.applyCardFile(event.data.file);
          return;
        case 'deck_import_started':
          if (event.data.deck_id !== deckId) return;
          deckImports.applyOpenRun(deckId, event.data.run.id);
          return;
        case 'deck_import_finished':
          if (event.data.deck_id !== deckId) return;
          deckImports.applyOpenRun(deckId, null);
          return;
        default:
          return;
      }
    });
    return () => {
      off();
      realtime.unsubscribe(id);
    };
  });

  $effect(() => {
    const project = projectId;
    const id = deckId;
    void deckImports.loadBinding(project, id).catch(() => {});
  });

  function asInput(list: readonly DeckCard[]) {
    return list.map((card) => ({ file_id: card.file_id, quantity: card.quantity }));
  }

  async function saveCards(next: readonly DeckCard[]) {
    try {
      await decks.saveCards(deckId, asInput(next));
    } catch (caught) {
      toasts.error(apiMessage(caught));
      // Refetch rather than roll back to a snapshot: the server's answer is the
      // one that is true, and a snapshot can be older than another editor's save.
      await decks.refreshDeck().catch(() => {});
    }
  }

  async function patch(fields: Parameters<typeof decks.update>[1]) {
    try {
      await decks.update(deckId, fields);
    } catch (caught) {
      toasts.error(apiMessage(caught));
      await decks.refreshDeck().catch(() => {});
    }
  }

  // Discarding is not undoing: the pages that landed keep the versions they
  // wrote. It is here because the app that opened the run may be a tab someone
  // has closed, and until the run is settled the deck refuses the next import.
  async function discardImport() {
    const runId = openRunId;
    if (!runId || discarding) return;
    discarding = true;
    try {
      await deckImports.abandon(runId);
    } catch (caught) {
      toasts.error(apiMessage(caught));
    } finally {
      discarding = false;
    }
  }

  // A deck owns its cards, so adding one is either an upload into the deck or a
  // move out of Assets. Both put the deck_card row there on the server, which
  // is what keeps the deck from ever holding artwork with no place in it.
  async function uploadCards(list: FileList | null) {
    if (!list || list.length === 0) return;
    uploading = true;
    try {
      // Sequential rather than parallel: the quota is checked per request, and
      // a burst of concurrent uploads can each pass a check the set fails.
      for (const file of Array.from(list)) {
        try {
          await files.upload(projectId, { deck_id: deckId }, file);
        } catch (caught) {
          toasts.error(`${file.name}: ${apiMessage(caught)}`);
        }
      }
      await decks.refreshDeck().catch(() => {});
    } finally {
      uploading = false;
    }
  }

  async function moveIn(chosen: File[]) {
    picking = null;
    for (const file of chosen) {
      try {
        await files.moveFile(file.id, { deck_id: deckId });
      } catch (caught) {
        toasts.error(`${file.filename}: ${apiMessage(caught)}`);
      }
    }
    await decks.refreshDeck().catch(() => {});
  }

  // Out of the deck, not out of the list: leaving a card in the deck with no
  // place in it is the one state a deck owning its artwork does not have.
  async function moveOut(card: DeckCard) {
    if (!confirm(`Move ${card.file.filename} to Assets? It leaves this deck.`)) return;
    try {
      await files.moveFile(card.file_id, { folder_id: null });
      await decks.refreshDeck();
    } catch (caught) {
      toasts.error(apiMessage(caught));
    }
  }

  async function removeCard(card: DeckCard) {
    if (!confirm(`Delete ${card.file.filename}? Its history is kept, and Deleted can put it back.`))
      return;
    try {
      await files.deleteFile(card.file_id);
      await decks.refreshDeck();
    } catch (caught) {
      toasts.error(apiMessage(caught));
    }
  }

  function setQuantity(fileId: string, quantity: number) {
    const clamped = Math.max(minQuantity, Math.min(maxQuantity, Math.round(quantity)));
    void saveCards(
      cards.map((card) => (card.file_id === fileId ? { ...card, quantity: clamped } : card))
    );
  }

  // These fields are typed over rather than edited: whatever is in one is a
  // whole number somebody is replacing, so focusing it selects what is there.
  function selectAll(event: FocusEvent & { currentTarget: HTMLInputElement }) {
    event.currentTarget.select();
  }

  // Tab walks the copy counts and nothing else. A sixty-card deck is sixty
  // numbers to type, and the four buttons a row carries sit between every pair
  // of them; they are reachable with the pointer.
  function moveBetweenCopies(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (event.key !== 'Tab') return;
    const row = event.currentTarget.closest('li');
    const sibling = event.shiftKey ? row?.previousElementSibling : row?.nextElementSibling;
    const next = sibling?.querySelector<HTMLInputElement>('input[data-copies]');
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  function move(index: number, by: number) {
    const next = [...cards];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void saveCards(next);
  }

  function applyPreset(id: string) {
    const preset = cardPreset(id);
    if (preset) void patch({ card_width_mm: preset.width_mm, card_height_mm: preset.height_mm });
  }

  // The file rows already carry their pixel dimensions, so this costs nothing to
  // say and is the difference between a proof that looks right on screen and one
  // that prints soft.
  // What the row says beside the name, for the viewer to say under it: at the
  // size the artwork is finally drawn, the count and the back are the two
  // things that are no longer anywhere on screen.
  function cardNote(card: DeckCard): string {
    const parts = [`${card.quantity} ${card.quantity === 1 ? 'copy' : 'copies'}`];
    if (card.file_id === backFileId) parts.push('this deck\u2019s back');
    if (card.file.deleted_at) parts.push('deleted');
    return parts.join(' \u00b7 ');
  }

  function resolution(card: DeckCard): number | null {
    if (!deck || card.file.image_width === null || card.file.image_height === null) return null;
    return Math.min(
      effectiveDpi(card.file.image_width, deck.card_width_mm),
      effectiveDpi(card.file.image_height, deck.card_height_mm)
    );
  }
</script>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8" use:link>
  {#if error}
    <p role="alert" class="rounded-md border border-danger p-4 text-sm text-danger">{error}</p>
    <a class="focus-ring rounded underline" href="/projects/{projectId}/decks">Back to decks</a>
  {:else if !deck}
    <Spinner label="Loading deck" />
  {:else}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="min-w-0">
        <a class="focus-ring rounded text-sm underline" href="/projects/{projectId}/decks">Decks</a>
        <h1 class="truncate text-2xl font-semibold">{deck.name}</h1>
        <p class="text-sm text-muted">
          {cards.length}
          {cards.length === 1 ? 'card' : 'cards'} · {totalCopies} to print
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <a
          class="focus-ring rounded px-3 py-2 text-sm underline"
          href="/projects/{projectId}/decks/{deck.id}/history"
        >
          Import history
        </a>
        <a
          class="focus-ring rounded px-3 py-2 text-sm underline"
          href="/projects/{projectId}/print?deck={deck.id}"
        >
          Print this deck
        </a>
      </div>
    </div>

    <section class="flex flex-col gap-4 rounded-md border border-edge bg-surface p-4">
      <h2 class="text-lg font-semibold">Settings</h2>

      <div class="flex flex-wrap items-end gap-4">
        <div class="min-w-56 flex-1">
          <Input
            label="Name"
            bind:value={name}
            maxlength={120}
            disabled={!canEdit}
            onblur={() => {
              if (name.trim() && name.trim() !== deck.name) void patch({ name: name.trim() });
            }}
          />
        </div>

        <div class="flex min-w-56 flex-1 flex-col gap-1">
          <label class="text-sm font-medium text-ink" for="{uid}-size">Card size</label>
          <select
            id="{uid}-size"
            class="focus-ring min-h-11 rounded-md border border-edge bg-surface px-2 text-sm"
            value={presetId}
            disabled={!canEdit}
            onchange={(event) => applyPreset(event.currentTarget.value)}
          >
            <option value="">Custom</option>
            {#each CARD_PRESETS as preset (preset.id)}
              <option value={preset.id}>{preset.name}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="flex flex-wrap gap-4">
        <div class="w-32">
          <Input
            label="Width"
            type="number"
            value={String(deck.card_width_mm)}
            min={limits.width_mm[0]}
            max={limits.width_mm[1]}
            step={0.5}
            disabled={!canEdit}
            onfocus={selectAll}
            onchange={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value)) void patch({ card_width_mm: value });
            }}
          />
        </div>
        <div class="w-32">
          <Input
            label="Height"
            type="number"
            value={String(deck.card_height_mm)}
            min={limits.height_mm[0]}
            max={limits.height_mm[1]}
            step={0.5}
            disabled={!canEdit}
            onfocus={selectAll}
            onchange={(event) => {
              const value = Number(event.currentTarget.value);
              if (Number.isFinite(value)) void patch({ card_height_mm: value });
            }}
          />
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <h3 class="text-sm font-medium">Card back</h3>
        {#if backFile}
          <div class="flex items-center gap-3">
            <Thumbnail fileId={backFile.id} alt="" />
            <span class="min-w-0 flex-1 truncate text-sm">{backFile.filename}</span>
          </div>
        {:else}
          <p class="text-sm text-muted">
            No back chosen. Sheets for this deck will print fronts only.
          </p>
        {/if}

        {#if canEdit}
          <div class="flex flex-col gap-1">
            <label class="text-sm" for="{uid}-back">Use one of this deck's images</label>
            <select
              id="{uid}-back"
              class="focus-ring min-h-11 rounded-md border border-edge bg-surface px-2 text-sm"
              value={backFileId ?? ''}
              onchange={(event) => patch({ back_file_id: event.currentTarget.value || null })}
            >
              <option value="">No back</option>
              <!-- Deleted artwork prints nothing, so it is not offered -- but the
                   one already chosen stays listed, or the select would read "No
                   back" over a deck that has one. -->
              {#each backChoices as card (card.file_id)}
                <option value={card.file_id}>{card.file.filename}</option>
              {/each}
            </select>
            <p class="text-xs text-muted">
              A deck's back is one of its own images. Upload it below, or move it in from Assets.
            </p>
          </div>
        {/if}
      </div>
    </section>

    {#if canEdit}
      <section class="flex flex-col gap-3 rounded-md border border-edge bg-surface p-4">
        <h2 class="text-lg font-semibold">Import from Canva</h2>
        {#if importStatus}
          <p class="text-sm text-muted">{importStatus}</p>
        {/if}
        <p class="text-sm text-muted">
          Open the Three Peaks app in Canva and push the design you have open into this deck. It
          asks for a code the first time; enter it on your
          <a class="focus-ring rounded underline" href="/account">account page</a>.
        </p>

        {#if openRunId}
          <div class="flex flex-col gap-2 rounded-md border border-warning p-3">
            <p role="status" class="text-sm">
              An import is open, so the next one will be refused until this is settled. Finishing it
              is the Canva app's to do; discarding it here leaves every page that has already landed
              in the deck and removes nothing.
            </p>
            <div>
              <Button variant="danger" disabled={discarding} onclick={discardImport}>
                {discarding ? 'Discarding…' : 'Discard this import'}
              </Button>
            </div>
          </div>
        {/if}
      </section>
    {/if}

    <section class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-lg font-semibold">Cards</h2>
        {#if canEdit}
          <div class="flex flex-wrap items-center gap-2">
            <label
              class="focus-within:focus-ring inline-flex min-h-11 cursor-pointer items-center
                     rounded-md bg-accent px-4 text-sm font-medium text-on-accent
                     hover:bg-accent-strong"
            >
              {uploading ? 'Uploading…' : 'Upload cards'}
              <input
                class="sr-only"
                type="file"
                multiple
                accept="image/*"
                disabled={uploading}
                onchange={(event) => {
                  const input = event.currentTarget;
                  void uploadCards(input.files).finally(() => (input.value = ''));
                }}
              />
            </label>
            <Button
              variant="secondary"
              onclick={() => (picking = picking === 'cards' ? null : 'cards')}
            >
              Move in from Assets
            </Button>
          </div>
        {/if}
      </div>

      {#if picking === 'cards'}
        <FilePicker
          {projectId}
          multiple
          onpick={(chosen) => void moveIn(chosen)}
          oncancel={() => (picking = null)}
        />
      {/if}

      {#if decks.loadingDeck && cards.length === 0}
        <Spinner label="Loading cards" />
      {:else if cards.length === 0}
        <p class="text-sm text-muted">
          No cards yet. {canEdit
            ? 'Add images and set how many copies of each the deck holds.'
            : ''}
        </p>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each cards as card, index (card.file_id)}
            {@const dpi = resolution(card)}
            {@const isBack = card.file_id === backFileId}
            <li
              class="flex flex-wrap items-center gap-3 rounded-md border border-edge bg-surface p-2"
            >
              <button
                type="button"
                class="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-md text-left"
                onclick={() => (viewing = card.file_id)}
              >
                <span class="sr-only">View</span>
                <Thumbnail fileId={card.file_id} alt="" />
                <span
                  class="min-w-0 flex-1 truncate text-sm {card.file.deleted_at
                    ? 'text-muted line-through'
                    : ''}"
                >
                  {card.file.filename}
                </span>
              </button>

              <label class="flex items-center gap-2 text-sm">
                <span class="text-muted">Copies</span>
                <input
                  type="number"
                  data-copies
                  class="focus-ring min-h-11 w-20 rounded-md border border-edge bg-surface px-2 text-sm"
                  value={card.quantity}
                  min={minQuantity}
                  max={maxQuantity}
                  step="1"
                  disabled={!canEdit}
                  onfocus={selectAll}
                  onkeydown={moveBetweenCopies}
                  onchange={(event) => setQuantity(card.file_id, Number(event.currentTarget.value))}
                />
              </label>

              {#if canEdit}
                <div class="flex gap-1">
                  <Button
                    variant="ghost"
                    aria-label="Move {card.file.filename} earlier"
                    disabled={index === 0}
                    onclick={() => move(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label="Move {card.file.filename} later"
                    disabled={index === cards.length - 1}
                    onclick={() => move(index, 1)}
                  >
                    ↓
                  </Button>
                  <Button variant="ghost" onclick={() => void moveOut(card)}>To Assets</Button>
                  <Button variant="ghost" onclick={() => void removeCard(card)}>Delete</Button>
                </div>
              {/if}

              {#if card.file.deleted_at || isBack || (dpi !== null && dpi < PRINT_DPI)}
                <div class="basis-full">
                  {#if card.file.deleted_at}
                    <p class="text-xs text-danger">Deleted. Restore it to print this card.</p>
                  {:else}
                    {#if isBack}
                      <p class="text-xs text-accent">
                        This deck’s back. It prints on the reverse of every card rather than as one,
                        which is what no copies of it means.
                      </p>
                    {/if}
                    {#if dpi !== null && dpi < PRINT_DPI}
                      <p class="text-xs text-warning">
                        {Math.round(dpi)} DPI at this size — under the {PRINT_DPI} DPI a printer wants.
                      </p>
                    {/if}
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <CardViewer cards={viewerCards} bind:openId={viewing} />
  {/if}
</div>
