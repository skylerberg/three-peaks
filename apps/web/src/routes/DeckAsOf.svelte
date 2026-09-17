<script lang="ts">
  import type { components } from '@three-peaks/shared/api';
  import CardViewer from '../components/CardViewer.svelte';
  import Thumbnail from '../components/Thumbnail.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import { ApiError } from '../api/client.ts';
  import { deckHistory } from '../lib/deckHistory.svelte.ts';
  import { link } from '../lib/router.svelte.ts';
  import { apiMessage } from '../lib/session.svelte.ts';

  type AsOfCard = components['schemas']['ImportRunDeck']['cards'][number];

  interface Props {
    projectId: string;
    deckId: string;
    runId: string;
  }
  let { projectId, deckId, runId }: Props = $props();

  let error = $state<string | null>(null);
  let viewing = $state<string | null>(null);

  const key = $derived(`${deckId}:${runId}`);
  const loaded = $derived(deckHistory.asOfKey === key);
  const asOf = $derived(loaded ? deckHistory.asOf : null);
  const refusal = $derived(loaded ? deckHistory.asOfRefusal : null);

  // A card the run left no version of is drawn without artwork, so it is not
  // one of the viewer's stops either.
  const viewerCards = $derived(
    (asOf?.cards ?? []).flatMap((card) =>
      card.file_version_number === null
        ? []
        : [
            {
              id: card.card_id,
              fileId: card.file_id,
              title: card.name,
              version: card.file_version_number,
              note: [
                `Version ${card.file_version_number}`,
                tombstone(card, asOf?.run.finished_at ?? null),
              ]
                .filter((part) => part !== null)
                .join(' \u00b7 '),
            },
          ]
    )
  );

  $effect(() => {
    const deck = deckId;
    const run = runId;
    error = null;
    void deckHistory.loadAsOf(deck, run).catch((caught: unknown) => {
      error =
        caught instanceof ApiError && caught.status === 404
          ? 'That import does not exist, or you do not have access to it.'
          : apiMessage(caught);
    });
  });

  function when(timestamp: string): string {
    return new Date(timestamp).toLocaleString();
  }

  // The tombstone is dated, so the badge is answered against the run in front
  // of somebody rather than against now. Deleting a card's image never took the
  // card out of the deck, so the card stood here either way -- what changes is
  // whether this import is the thing it outlived.
  function tombstone(card: AsOfCard, anchor: string | null): string | null {
    if (card.image_deleted_at === null) return null;
    if (anchor === null) return 'Deleted';
    return Date.parse(card.image_deleted_at) > Date.parse(anchor)
      ? 'Deleted since this import'
      : 'Deleted before this import';
  }
</script>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8" use:link>
  {#if error}
    <p role="alert" class="rounded-md border border-danger p-4 text-sm text-danger">{error}</p>
    <a
      class="focus-ring w-fit rounded underline"
      href="/projects/{projectId}/decks/{deckId}/history">Back to import history</a
    >
  {:else if refusal}
    <p role="status" class="rounded-md border border-warning p-4 text-sm text-warning">{refusal}</p>
    <a
      class="focus-ring w-fit rounded underline"
      href="/projects/{projectId}/decks/{deckId}/history">Back to import history</a
    >
  {:else if !asOf}
    <Spinner label="Loading the deck as it stood" />
  {:else}
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div class="min-w-0">
        <h1 class="text-2xl font-semibold">The deck as it stood</h1>
        <p class="text-sm text-muted">
          <time datetime={asOf.run.started_at}>{when(asOf.run.started_at)}</time>
          · {asOf.run.source_label ?? 'an export with no name'}
        </p>
      </div>
      <a
        class="focus-ring rounded px-3 py-2 text-sm underline"
        href="/projects/{projectId}/decks/{deckId}/history"
      >
        Back to import history
      </a>
    </div>

    <p class="text-sm text-muted">
      Every card the imports had put in this deck after that import, each at the version that import
      left it. Order, copy counts and the card back are not recorded, and cards someone added or
      removed by hand are not either — this is a photograph of the artwork, not a restore point.
    </p>

    {#if asOf.has_purged_history}
      <p role="status" class="rounded-md border border-warning p-4 text-sm text-warning">
        Some artwork in this deck's history has been permanently deleted. If any of it was in the
        deck at this point, it cannot be shown.
      </p>
    {/if}

    {#if asOf.cards.length === 0}
      <p class="rounded-md border border-edge bg-surface p-4 text-sm text-muted">
        The imports had put no cards in this deck at this point.
      </p>
    {:else}
      <ul class="grid gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {#each asOf.cards as card (card.card_id)}
          {@const deleted = tombstone(card, asOf.run.finished_at)}
          <li class="flex flex-col gap-2 rounded-md border border-edge bg-surface p-3">
            {#if card.file_version_number === null}
              <p class="text-sm text-muted">The version this import left is not recorded.</p>
              <p class="min-w-0 truncate font-medium">{card.name}</p>
            {:else}
              <button
                type="button"
                class="focus-ring flex w-full min-w-0 flex-col gap-2 rounded-md text-left"
                onclick={() => (viewing = card.card_id)}
              >
                <span class="sr-only">View</span>
                <!-- contain, not cover: a card cropped to a square answers nothing. -->
                <Thumbnail
                  fileId={card.file_id}
                  version={card.file_version_number}
                  class="h-40 w-full"
                  fit="contain"
                  alt=""
                />
                <span class="w-full min-w-0 truncate font-medium">{card.name}</span>
              </button>
            {/if}
            <p class="flex flex-wrap items-center gap-2 text-sm text-muted">
              {#if card.file_version_number !== null}
                <span>Version {card.file_version_number}</span>
              {/if}
              {#if deleted}
                <span class="rounded-full border border-warning px-2 py-0.5 text-xs text-warning">
                  {deleted}
                </span>
              {/if}
            </p>
            <a
              class="focus-ring inline-flex min-h-11 items-center rounded text-sm underline"
              href="/projects/{projectId}/files/{card.file_id}/versions"
            >
              Version history
            </a>
          </li>
        {/each}
      </ul>
    {/if}

    <CardViewer cards={viewerCards} bind:openId={viewing} />
  {/if}
</div>
