<script lang="ts">
  import type { components } from '@three-peaks/shared/api';
  import { IMPORT_OUTCOMES } from '@three-peaks/shared';
  import CardViewer from '../components/CardViewer.svelte';
  import Thumbnail from '../components/Thumbnail.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import { ApiError } from '../api/client.ts';
  import { deckHistory } from '../lib/deckHistory.svelte.ts';
  import { link } from '../lib/router.svelte.ts';
  import { apiMessage } from '../lib/session.svelte.ts';

  type RunCard = components['schemas']['ImportRunDetail']['cards'][number];
  // A card and the id the viewer knows it by. The response's own order is what
  // mints the id, because the groups below scatter these rows across four
  // sections and nothing else about a row is unique -- two pages may carry one
  // name.
  interface Shown {
    id: string;
    card: RunCard;
  }

  interface Props {
    projectId: string;
    deckId: string;
    runId: string;
  }
  let { projectId, deckId, runId }: Props = $props();

  let error = $state<string | null>(null);
  let viewing = $state<string | null>(null);

  // Removed first: it is the outcome somebody came to find, and burying it under
  // fifty unchanged rows is what this ordering exists to avoid.
  const GROUPS = [
    'removed',
    'added',
    'updated',
    'unchanged',
  ] as const satisfies readonly (typeof IMPORT_OUTCOMES)[number][];

  const HEADINGS: Record<(typeof GROUPS)[number], string> = {
    removed: 'Removed',
    added: 'Added',
    updated: 'Updated',
    unchanged: 'Unchanged',
  };

  const loaded = $derived(deckHistory.detailKey === `${deckId}:${runId}`);
  const detail = $derived(loaded ? deckHistory.detail : null);
  const cards = $derived<RunCard[]>(detail?.cards ?? []);
  const shown = $derived<Shown[]>(cards.map((card, index) => ({ id: String(index), card })));
  const groups = $derived(
    GROUPS.map((outcome) => ({
      outcome,
      heading: HEADINGS[outcome],
      rows: shown.filter((row) => row.card.outcome === outcome),
    })).filter((group) => group.rows.length > 0)
  );
  // Anything the API has learned to say since this bundle was built. Without
  // this its rows would simply not be on the screen.
  const other = $derived(
    shown.filter((row) => !GROUPS.some((outcome) => outcome === row.card.outcome))
  );

  // The order the sections are drawn in, not the order the rows arrived, so the
  // arrow keys walk the screen. A card whose image has been purged has nothing
  // to open and is no stop along the way.
  const viewerCards = $derived(
    [...groups.flatMap((group) => group.rows), ...other].flatMap((row) =>
      row.card.file_id === null
        ? []
        : [
            {
              id: row.id,
              fileId: row.card.file_id,
              title: row.card.name,
              version: row.card.file_version_number ?? undefined,
              note: matchLabel(row.card),
            },
          ]
    )
  );

  $effect(() => {
    const deck = deckId;
    const run = runId;
    error = null;
    void deckHistory.loadRun(deck, run).catch((caught: unknown) => {
      error =
        caught instanceof ApiError && caught.status === 404
          ? 'That import does not exist, or you do not have access to it.'
          : apiMessage(caught);
    });
  });

  function when(timestamp: string): string {
    return new Date(timestamp).toLocaleString();
  }

  // Strongest tier first, and every one of them named: which tier placed a card
  // is how much to trust that it landed on the right artwork.
  function matchLabel(card: RunCard): string {
    if (card.matched_by === 'page_id') return 'matched by Canva page';
    if (card.matched_by === 'identity') return 'matched by page name';
    if (card.matched_by === 'page_number') return 'matched by page number';
    return 'new card';
  }
</script>

{#snippet rows(list: Shown[])}
  <ul class="flex flex-col divide-y divide-edge">
    {#each list as row (row.id)}
      {@const card = row.card}
      <li class="flex flex-wrap items-center gap-3 p-3">
        {#if card.file_id === null}
          <div class="min-w-0 flex-1 text-muted">
            <p class="truncate font-medium">{card.name}</p>
            <p class="text-sm">This image has been permanently deleted.</p>
          </div>
        {:else}
          <button
            type="button"
            class="focus-ring flex min-w-0 flex-1 items-center gap-3 rounded-md text-left"
            onclick={() => (viewing = row.id)}
          >
            <span class="sr-only">View</span>
            <Thumbnail
              fileId={card.file_id}
              version={card.file_version_number ?? undefined}
              alt=""
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate font-medium">{card.name}</span>
              <span class="block text-sm text-muted">{matchLabel(card)}</span>
            </span>
          </button>
          {#if card.restored}
            <span class="rounded-full bg-accent px-2 py-0.5 text-xs text-on-accent">Put back</span>
          {/if}
          <a
            class="focus-ring inline-flex min-h-11 items-center rounded px-3 text-sm underline"
            href="/projects/{projectId}/files/{card.file_id}/versions"
          >
            Version history
          </a>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

<div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8" use:link>
  {#if error}
    <p role="alert" class="rounded-md border border-danger p-4 text-sm text-danger">{error}</p>
    <a
      class="focus-ring w-fit rounded underline"
      href="/projects/{projectId}/decks/{deckId}/history">Back to import history</a
    >
  {:else if !detail}
    <Spinner label="Loading this import" />
  {:else}
    <div class="flex flex-wrap items-baseline justify-between gap-2">
      <div class="min-w-0">
        <h1 class="text-2xl font-semibold">What this import changed</h1>
        <p class="text-sm text-muted">
          <time datetime={detail.run.started_at}>{when(detail.run.started_at)}</time>
          · {detail.run.source_label ?? 'an export with no name'}
        </p>
        <p class="text-sm">
          <span aria-hidden="true">
            +{detail.run.counts.added} ~{detail.run.counts.updated} −{detail.run.counts.removed}
          </span>
          <span class="sr-only">
            {detail.run.counts.added} added, {detail.run.counts.updated} updated,
            {detail.run.counts.removed} removed
          </span>
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
      Updated means this import matched the card and wrote to it. A page renamed with the same
      artwork counts here too, and saves no new version.
    </p>

    {#each groups as group (group.outcome)}
      {#if group.outcome === 'unchanged'}
        <details class="rounded-md border border-edge bg-surface">
          <summary
            class="focus-ring flex min-h-11 cursor-pointer items-center rounded-md px-3 text-lg
                   font-semibold"
          >
            {group.rows.length} unchanged
          </summary>
          {@render rows(group.rows)}
        </details>
      {:else}
        <section class="rounded-md border border-edge bg-surface">
          <h2 class="px-3 py-3 text-lg font-semibold">
            {group.heading} ({group.rows.length})
          </h2>
          {@render rows(group.rows)}
        </section>
      {/if}
    {/each}

    {#if other.length > 0}
      <section class="rounded-md border border-edge bg-surface">
        <h2 class="px-3 py-3 text-lg font-semibold">Other ({other.length})</h2>
        {@render rows(other)}
      </section>
    {/if}

    <CardViewer cards={viewerCards} bind:openId={viewing} />
  {/if}
</div>
