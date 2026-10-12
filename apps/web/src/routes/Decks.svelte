<script lang="ts">
  import {
    CARD_PRESETS,
    DEFAULT_CARD_PRESET_ID,
    cardPreset,
    deckCardSize,
    matchingCardPreset,
  } from '@three-peaks/shared';
  import Button from '../components/ui/Button.svelte';
  import Input from '../components/ui/Input.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import { ApiError, api, assertOk } from '../api/client.ts';
  import { decks } from '../lib/decks.svelte.ts';
  import { realtime } from '../lib/realtime.svelte.ts';
  import { link, router } from '../lib/router.svelte.ts';
  import { apiMessage } from '../lib/session.svelte.ts';
  import { toasts } from '../lib/toasts.svelte.ts';

  interface Props {
    projectId: string;
  }
  let { projectId }: Props = $props();

  let error = $state<string | null>(null);
  let canEdit = $state(false);
  let creating = $state(false);
  let newName = $state('');
  let newSizeId = $state(DEFAULT_CARD_PRESET_ID);
  let busy = $state(false);

  const list = $derived(decks.decks);
  const uid = $props.id();

  $effect(() => {
    const id = projectId;
    error = null;
    void decks.loadList(id).catch((caught: unknown) => {
      error =
        caught instanceof ApiError && caught.status === 404
          ? 'That project does not exist, or you do not have access to it.'
          : apiMessage(caught);
    });
  });

  $effect(() => {
    const id = projectId;
    api
      .GET('/api/projects/{id}', { params: { path: { id } } })
      .then((result) => {
        canEdit = assertOk(result).role === 'editor';
      })
      .catch(() => {
        // The listing above owns the error message; without the project row this
        // screen is read-only, which is the safe way to be wrong.
        canEdit = false;
      });
  });

  $effect(() => {
    const id = projectId;
    realtime.subscribe(id);
    // Every row this listing draws is on the event that changed it.
    const off = realtime.on((event) => {
      if (event.project_id !== id) return;
      if (event.type === 'deck_created') decks.applyDeckCreated(event.data);
      else if (event.type === 'deck_updated')
        decks.applyDeckUpdate(event.data.deck, event.data.cards);
      else if (event.type === 'deck_deleted') decks.applyDeckDeleted(event.data.id);
    });
    return () => {
      off();
      realtime.unsubscribe(id);
    };
  });

  function sizeLabel(deck: { card_width_mm: number; card_height_mm: number }): string {
    const preset = matchingCardPreset(deckCardSize(deck));
    return preset ? preset.name : `${deck.card_width_mm} × ${deck.card_height_mm} mm`;
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    const name = newName.trim();
    const preset = cardPreset(newSizeId);
    if (!name || !preset) return;

    busy = true;
    try {
      const deck = await decks.create(projectId, {
        name,
        card_width_mm: preset.width_mm,
        card_height_mm: preset.height_mm,
      });
      newName = '';
      creating = false;
      router.navigate(`/projects/${projectId}/decks/${deck.id}`);
    } catch (caught) {
      toasts.error(apiMessage(caught));
    } finally {
      busy = false;
    }
  }

  async function remove(deckId: string, name: string) {
    if (!confirm(`Delete the deck "${name}"? Its cards go with it, and Deleted can put it back.`))
      return;
    try {
      await decks.remove(deckId);
    } catch (caught) {
      toasts.error(apiMessage(caught));
    }
  }
</script>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8" use:link>
  {#if error}
    <p role="alert" class="rounded-md border border-danger p-4 text-sm text-danger">{error}</p>
    <a class="focus-ring rounded underline" href="/projects/{projectId}">Back to the project</a>
  {:else}
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1 class="text-2xl font-semibold">Decks</h1>
        <p class="text-sm text-muted">
          A deck is an ordered list of card images with a copy count each, one card size, and one
          back.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <a class="focus-ring rounded px-3 py-2 text-sm underline" href="/projects/{projectId}">
          Files
        </a>
        {#if list.length > 0}
          <a
            class="focus-ring rounded px-3 py-2 text-sm underline"
            href="/projects/{projectId}/print"
          >
            Print
          </a>
        {/if}
        {#if canEdit}
          <Button onclick={() => (creating = !creating)}>New deck</Button>
        {/if}
      </div>
    </div>

    {#if creating}
      <form
        class="flex flex-col gap-4 rounded-md border border-edge bg-surface p-4"
        onsubmit={create}
      >
        <Input label="Name" bind:value={newName} maxlength={120} required autocomplete="off" />
        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium text-ink" for="{uid}-size">Card size</label>
          <select
            id="{uid}-size"
            class="focus-ring min-h-11 rounded-md border border-edge bg-surface px-2 text-sm"
            bind:value={newSizeId}
          >
            {#each CARD_PRESETS as preset (preset.id)}
              <option value={preset.id}>{preset.name}</option>
            {/each}
          </select>
          <p class="text-xs text-muted">
            Panda Game Manufacturing’s standard sizes. Changeable afterwards.
          </p>
        </div>
        <div class="flex gap-2">
          <Button type="submit" disabled={busy || newName.trim().length === 0}>Create</Button>
          <Button variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
        </div>
      </form>
    {/if}

    {#if decks.loadingList && list.length === 0}
      <Spinner label="Loading decks" />
    {:else if list.length === 0}
      <p class="text-sm text-muted">
        No decks yet. {canEdit ? 'Create one to start counting copies and printing proofs.' : ''}
      </p>
    {:else}
      <ul class="flex flex-col gap-2">
        {#each list as deck (deck.id)}
          <li
            class="flex flex-wrap items-center gap-3 rounded-md border border-edge bg-surface p-3"
          >
            <a
              class="focus-ring min-w-0 flex-1 rounded font-medium underline"
              href="/projects/{projectId}/decks/{deck.id}"
            >
              {deck.name}
            </a>
            <span class="text-sm text-muted">{sizeLabel(deck)}</span>
            <span class="text-sm text-muted">
              {deck.card_count}
              {deck.card_count === 1 ? 'card' : 'cards'} · {deck.total_copies} printed
            </span>
            <a
              class="focus-ring rounded px-3 py-2 text-sm underline"
              href="/projects/{projectId}/print?deck={deck.id}"
            >
              Print
            </a>
            {#if canEdit}
              <Button variant="ghost" onclick={() => remove(deck.id, deck.name)}>Delete</Button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
