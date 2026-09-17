<script lang="ts">
  import {
    DEFAULT_PAGE_SIZE_ID,
    DEFAULT_PRINTER_MARGIN_MM,
    PAGE_SIZES,
    PRINTER_MARGIN_LIMITS,
    type FlipEdge,
    deckCardSize,
    matchingCardPreset,
    pageSize,
    planGrid,
    planRuns,
    summarizeRuns,
  } from '@three-peaks/shared';
  import Button from '../components/ui/Button.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import { ApiError } from '../api/client.ts';
  import { type Deck, type DeckCard, decks } from '../lib/decks.svelte.ts';
  import { saveBlob } from '../lib/download.ts';
  import {
    type OutstandingCard,
    type OutstandingDeck,
    type PrintMode,
    type PrintRun,
    type RecordedCard,
    copiesToPrint,
    outstandingLabel,
    readOutstanding,
    recordPrintRun,
    undoPrintRun,
  } from '../lib/printRuns.ts';
  import { link } from '../lib/router.svelte.ts';
  import { apiMessage } from '../lib/session.svelte.ts';
  import { toasts } from '../lib/toasts.svelte.ts';

  interface Props {
    projectId: string;
    deckId: string | null;
  }
  let { projectId, deckId }: Props = $props();

  interface LoadedDeck {
    deck: Deck;
    cards: DeckCard[];
  }

  let error = $state<string | null>(null);
  let loading = $state(true);
  let loaded = $state<LoadedDeck[]>([]);
  let expanded = $state<Record<string, boolean>>({});
  // Which cards this run puts on paper, keyed deck:file, without changing what
  // the deck holds -- the deck's own counts are the persistent truth and this is
  // one print job's opinion. A deck's own box is counted back off this rather
  // than held beside it, so the two cannot disagree.
  let included = $state<Record<string, boolean>>({});

  // What each card still owes the printer, as the API works it out. Held beside
  // the decks rather than folded into them: it is a fact about print runs, and
  // the deck rows are the same ones every other screen reads.
  let outstanding = $state<OutstandingDeck[]>([]);
  // The run this screen has just written down, and the only one it offers to
  // take back. A jammed sheet is the case; anything older is history.
  let recorded = $state<PrintRun | null>(null);
  let undoing = $state(false);

  let pageId = $state(DEFAULT_PAGE_SIZE_ID);
  let printerMargin = $state(DEFAULT_PRINTER_MARGIN_MM);
  let includeBacks = $state(true);
  let flip = $state<FlipEdge>('long');
  let cutMarks = $state(true);
  let fit = $state<'fill' | 'fit'>('fill');
  let oneOfEach = $state(false);
  let mode = $state<PrintMode>('all');
  let generating = $state(false);
  let progress = $state<{ drawn: number; total: number } | null>(null);

  const uid = $props.id();
  const page = $derived(pageSize(pageId) ?? PAGE_SIZES[0]);

  const key = (deck: string, file: string) => `${deck}:${file}`;

  // A card whose image is in the bin has no bytes to place, so it is neither
  // tickable nor counted towards its deck's box.
  const printable = (card: DeckCard) => card.file.deleted_at === null;

  // One lookup for the whole screen. A deck of five hundred cards is scanned
  // once here rather than once per row per recompute.
  const owed = $derived.by(() => {
    const byDeck: Record<string, Record<string, OutstandingCard>> = {};
    for (const deck of outstanding) {
      byDeck[deck.deck_id] = Object.fromEntries(deck.cards.map((card) => [card.file_id, card]));
    }
    return byDeck;
  });
  const owedDecks = $derived(
    Object.fromEntries(outstanding.map((deck) => [deck.deck_id, deck])) as Record<
      string,
      OutstandingDeck | undefined
    >
  );

  function outstandingFor(deckId: string, fileId: string): OutstandingCard | undefined {
    return owed[deckId]?.[fileId];
  }

  // What one card puts on paper, read by the plan and by the count beside its
  // name so the two cannot disagree.
  function printedCopies(deckId: string, card: DeckCard): number {
    return copiesToPrint(card.quantity, outstandingFor(deckId, card.file_id), mode, oneOfEach);
  }

  // Only what is ticked, with the version each card is drawn at carried
  // alongside -- the same number the run is recorded with, so the ledger names
  // the artwork that went through the printer.
  const runEntries = $derived(
    loaded
      .map((entry) => ({
        deck: entry.deck,
        state: owedDecks[entry.deck.id],
        cards: entry.cards
          .filter((card) => included[key(entry.deck.id, card.file_id)] === true)
          .map((card) => ({
            file_id: card.file_id,
            copies: printedCopies(entry.deck.id, card),
            version_number: outstandingFor(entry.deck.id, card.file_id)?.version_number ?? null,
          }))
          .filter((card) => card.copies > 0),
      }))
      .filter((entry) => entry.cards.length > 0)
  );

  const runDecks = $derived(
    runEntries.map((entry) => ({
      name: entry.deck.name,
      card: deckCardSize(entry.deck),
      back_file_id: entry.deck.back_file_id,
      cards: entry.cards.map((card) => ({ file_id: card.file_id, copies: card.copies })),
    }))
  );

  // Every version this screen knows about, backs included, so the document is
  // drawn from the same artwork the counts above were worked out against.
  const versions = $derived.by(() => {
    const pinned: Record<string, number> = {};
    for (const deck of outstanding) {
      for (const card of deck.cards) pinned[card.file_id] = card.version_number;
      if (deck.back_file_id !== null && deck.back_version_number !== null) {
        pinned[deck.back_file_id] = deck.back_version_number;
      }
    }
    return pinned;
  });

  // What to write down once the file exists. A card the outstanding read did
  // not name has no version to record, so it is left out rather than recorded
  // at a number nobody checked -- it simply stays owed.
  const recordable = $derived(
    runEntries.flatMap((entry) =>
      entry.cards
        .filter((card) => card.version_number !== null)
        .map((card): RecordedCard => {
          const back =
            includeBacks && entry.deck.back_file_id !== null && entry.state?.back_version_number
              ? {
                  back_file_id: entry.deck.back_file_id,
                  back_version_number: entry.state.back_version_number,
                }
              : {};
          return {
            file_id: card.file_id,
            version_number: card.version_number as number,
            copies: card.copies,
            ...back,
          };
        })
    )
  );

  const options = $derived({
    page,
    printer_margin_mm: printerMargin,
    include_backs: includeBacks,
    flip,
    cut_marks: cutMarks,
    fit,
  });

  // Recomputed from the same planner the renderer walks, so the sheet count on
  // screen is the page count of the file the button produces.
  const summary = $derived(summarizeRuns(planRuns(runDecks), page, printerMargin, includeBacks));

  const anyBacks = $derived(runDecks.some((entry) => entry.back_file_id !== null));

  // Every deck's box, counted off its own cards: checked when the whole deck is
  // ticked, mixed when part of it is, and nothing to tick at all when a deck
  // holds no printable card.
  const deckChoice = $derived.by(() => {
    const counted: Record<string, { total: number; chosen: number }> = {};
    for (const entry of loaded) {
      const cards = entry.cards.filter(printable);
      counted[entry.deck.id] = {
        total: cards.length,
        chosen: cards.filter((card) => included[key(entry.deck.id, card.file_id)] === true).length,
      };
    }
    return counted;
  });

  const anySelected = $derived(Object.values(deckChoice).some((choice) => choice.chosen > 0));

  function chooseWholeDeck(entry: LoadedDeck, choose: boolean) {
    for (const card of entry.cards) {
      if (printable(card)) included[key(entry.deck.id, card.file_id)] = choose;
    }
  }

  $effect(() => {
    const project = projectId;
    const preselect = deckId;
    loading = true;
    error = null;

    void (async () => {
      try {
        await decks.loadList(project);
        const list = decks.decks;
        const [full, pending] = await Promise.all([
          Promise.all(list.map((deck) => decks.readDeck(deck.id))),
          readOutstanding(project),
        ]);
        loaded = full;
        outstanding = pending;
        recorded = null;
        included = Object.fromEntries(
          full
            .filter((entry) => preselect === null || preselect === entry.deck.id)
            .flatMap((entry) =>
              entry.cards.filter(printable).map((card) => [key(entry.deck.id, card.file_id), true])
            )
        );
      } catch (caught) {
        error =
          caught instanceof ApiError && caught.status === 404
            ? 'That project does not exist, or you do not have access to it.'
            : apiMessage(caught);
      } finally {
        loading = false;
      }
    })();
  });

  function cardsPerSheet(deck: Deck): number {
    return planGrid(page, deckCardSize(deck), printerMargin).per_sheet;
  }

  function when(timestamp: string): string {
    return new Date(timestamp).toLocaleString();
  }

  function sizeLabel(deck: Deck): string {
    const preset = matchingCardPreset(deckCardSize(deck));
    return preset ? preset.name : `${deck.card_width_mm} × ${deck.card_height_mm} mm`;
  }

  async function generate() {
    generating = true;
    progress = null;
    // Snapshotted before the await: the recording has to name the cards that
    // went into this document, not whatever the boxes say by the time it is
    // built.
    const printed = $state.snapshot(recordable) as RecordedCard[];
    try {
      // Imported here and nowhere else, so jsPDF and the layout code sit in a
      // chunk only this screen pays for.
      const { generatePrintPdf } = await import('../lib/print/index.ts');
      const blob = await generatePrintPdf(
        { decks: runDecks, options, versions: $state.snapshot(versions) },
        (update) => {
          progress = update;
        }
      );

      saveBlob(blob, 'print-sheets.pdf');
      await record(printed);
    } catch (caught) {
      toasts.error(caught instanceof Error ? caught.message : 'The sheets could not be built.');
    } finally {
      generating = false;
      progress = null;
    }
  }

  // After the file, and never instead of it: the document is the thing that was
  // asked for, so a recording that fails says so and leaves the sheets alone.
  async function record(printed: RecordedCard[]) {
    if (printed.length === 0) return;
    try {
      recorded = await recordPrintRun(projectId, printed);
      outstanding = await readOutstanding(projectId);
    } catch (caught) {
      toasts.error(
        `The sheets were built, but recording them failed, so they still count as unprinted. ${apiMessage(caught)}`
      );
    }
  }

  async function undo() {
    const run = recorded;
    if (!run) return;
    undoing = true;
    try {
      await undoPrintRun(run.id);
      recorded = null;
      outstanding = await readOutstanding(projectId);
    } catch (caught) {
      toasts.error(apiMessage(caught));
    } finally {
      undoing = false;
    }
  }
</script>

<div class="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8" use:link>
  {#if error}
    <p role="alert" class="rounded-md border border-danger p-4 text-sm text-danger">{error}</p>
    <a class="focus-ring rounded underline" href="/projects/{projectId}/decks">Back to decks</a>
  {:else}
    <div>
      <a class="focus-ring rounded text-sm underline" href="/projects/{projectId}/decks">Decks</a>
      <h1 class="text-2xl font-semibold">Print sheets</h1>
      <p class="text-sm text-muted">
        Cards packed onto {page.name} at their real size, with a mirrored backing page behind every sheet.
        Print double-sided at 100% scale — never “fit to page”.
      </p>
    </div>

    {#if loading}
      <Spinner label="Loading decks" />
    {:else if loaded.length === 0}
      <p class="text-sm text-muted">
        This project has no decks yet.
        <a class="focus-ring rounded underline" href="/projects/{projectId}/decks">Make one</a>.
      </p>
    {:else}
      <section class="flex flex-col gap-2">
        <h2 class="text-lg font-semibold">What to print</h2>
        <ul class="flex flex-col gap-2">
          {#each loaded as entry (entry.deck.id)}
            {@const perSheet = cardsPerSheet(entry.deck)}
            {@const printedAt = owedDecks[entry.deck.id]?.last_printed_at ?? null}
            {@const choice = deckChoice[entry.deck.id]}
            <li class="rounded-md border border-edge bg-surface p-3">
              <div class="flex flex-wrap items-center gap-3">
                <label class="flex min-h-11 min-w-0 flex-1 items-center gap-3">
                  <input
                    type="checkbox"
                    class="focus-ring size-4"
                    checked={choice.total > 0 && choice.chosen === choice.total}
                    indeterminate={choice.chosen > 0 && choice.chosen < choice.total}
                    disabled={choice.total === 0}
                    onchange={(event) => chooseWholeDeck(entry, event.currentTarget.checked)}
                  />
                  <span class="min-w-0 flex-1 truncate font-medium">{entry.deck.name}</span>
                </label>
                {#if choice.chosen > 0 && choice.chosen < choice.total}
                  <span class="text-sm text-muted">{choice.chosen} of {choice.total} cards</span>
                {/if}
                <span class="text-sm text-muted">{sizeLabel(entry.deck)}</span>
                <span class="text-sm text-muted">
                  {perSheet > 0 ? `${perSheet} per sheet` : 'too large for this paper'}
                </span>
                <span class="text-sm text-muted">
                  {#if printedAt}
                    last printed <time datetime={printedAt}>{when(printedAt)}</time>
                  {:else}
                    never printed
                  {/if}
                </span>
                {#if entry.deck.back_file_id === null}
                  <span class="text-sm text-warning">no back</span>
                {/if}
                <Button
                  variant="ghost"
                  aria-expanded={expanded[entry.deck.id] === true}
                  onclick={() => (expanded[entry.deck.id] = !expanded[entry.deck.id])}
                >
                  {expanded[entry.deck.id] ? 'Hide cards' : 'Choose cards'}
                </Button>
              </div>

              {#if expanded[entry.deck.id]}
                <ul
                  class="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto border-t border-edge pt-2"
                >
                  {#each entry.cards as card (card.file_id)}
                    <li>
                      <label
                        class="flex min-h-11 items-center gap-3 rounded px-2 text-sm hover:bg-accent-soft"
                      >
                        <input
                          type="checkbox"
                          class="focus-ring size-4"
                          disabled={!printable(card)}
                          checked={included[key(entry.deck.id, card.file_id)] === true}
                          onchange={(event) => {
                            included[key(entry.deck.id, card.file_id)] =
                              event.currentTarget.checked;
                          }}
                        />
                        <span
                          class="min-w-0 flex-1 truncate {card.file.deleted_at
                            ? 'text-muted line-through'
                            : ''}"
                        >
                          {card.file.filename}
                        </span>
                        {#if !card.file.deleted_at}
                          {@const label = outstandingLabel(
                            outstandingFor(entry.deck.id, card.file_id)
                          )}
                          {#if label}
                            <span
                              class="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-xs text-accent"
                            >
                              {label}
                            </span>
                          {/if}
                        {/if}
                        <span class="text-muted">
                          {card.file.deleted_at
                            ? 'deleted'
                            : `×${printedCopies(entry.deck.id, card)}`}
                        </span>
                      </label>
                    </li>
                  {:else}
                    <li class="px-2 text-sm text-muted">This deck has no cards.</li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      </section>

      <section class="flex flex-col gap-4 rounded-md border border-edge bg-surface p-4">
        <h2 class="text-lg font-semibold">Options</h2>

        <div class="flex flex-col gap-1">
          <label class="text-sm font-medium" for="{uid}-mode">What to print</label>
          <select
            id="{uid}-mode"
            class="focus-ring min-h-11 max-w-96 rounded-md border border-edge bg-surface px-2 text-sm"
            bind:value={mode}
          >
            <option value="all">Everything selected</option>
            <option value="changed">Only what has changed since the last print</option>
          </select>
          <p class="max-w-96 text-xs text-muted">
            Changed means a card nothing has printed yet, artwork that has been updated since it was
            last printed, a card back the deck has replaced, or a copy count that has gone up.
          </p>
        </div>

        <div class="flex flex-wrap gap-6">
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" class="focus-ring size-4" bind:checked={includeBacks} />
            Include backing pages
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" class="focus-ring size-4" bind:checked={cutMarks} />
            Cut marks
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" class="focus-ring size-4" bind:checked={oneOfEach} />
            One of each, ignoring copy counts
          </label>
        </div>

        <div class="flex flex-wrap gap-6">
          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium" for="{uid}-flip">Duplex flip</label>
            <select
              id="{uid}-flip"
              class="focus-ring min-h-11 rounded-md border border-edge bg-surface px-2 text-sm"
              bind:value={flip}
              disabled={!includeBacks}
            >
              <option value="long">Long edge (the usual default)</option>
              <option value="short">Short edge</option>
            </select>
            <p class="max-w-80 text-xs text-muted">
              Match your printer’s two-sided setting. Getting this wrong puts every back on the
              wrong card.
            </p>
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium" for="{uid}-fit">Artwork</label>
            <select
              id="{uid}-fit"
              class="focus-ring min-h-11 rounded-md border border-edge bg-surface px-2 text-sm"
              bind:value={fit}
            >
              <option value="fill">Fill the card, cropping the overflow</option>
              <option value="fit">Fit inside the card, whole</option>
            </select>
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-sm font-medium" for="{uid}-margin">Printer margin</label>
            <input
              id="{uid}-margin"
              type="number"
              class="focus-ring min-h-11 w-28 rounded-md border border-edge bg-surface px-2 text-sm"
              bind:value={printerMargin}
              min={PRINTER_MARGIN_LIMITS[0]}
              max={PRINTER_MARGIN_LIMITS[1]}
              step="0.05"
            />
            <p class="max-w-80 text-xs text-muted">
              Millimetres your printer will not print inside. Lower it for more cards a sheet, at
              the risk of clipping the outer row.
            </p>
          </div>
        </div>
      </section>

      <section class="flex flex-col gap-3 rounded-md border border-edge bg-surface p-4">
        <p class="text-sm" role="status">
          {summary.cards}
          {summary.cards === 1 ? 'card' : 'cards'} on {summary.sheets}
          {summary.sheets === 1 ? 'sheet' : 'sheets'} of {page.name}{summary.sizes > 1
            ? `, across ${summary.sizes} card sizes`
            : ''}.
        </p>

        {#if summary.oversized}
          <p class="text-sm text-danger" role="alert">
            One of the selected decks has a card larger than the printable area. Lower the printer
            margin or choose a smaller size.
          </p>
        {/if}
        {#if includeBacks && !anyBacks && summary.cards > 0}
          <p class="text-sm text-warning">
            None of the selected decks has a card back, so the backing pages would be blank.
          </p>
        {/if}
        {#if mode === 'changed' && summary.cards === 0 && anySelected}
          <p class="text-sm text-muted">
            Everything selected is already on paper at its current artwork. Switch to “everything
            selected” to print it again.
          </p>
        {/if}
        {#if recorded}
          <div class="flex flex-wrap items-center gap-3">
            <p class="text-sm" role="status">
              Recorded as printed: {recorded.copies}
              {recorded.copies === 1 ? 'copy' : 'copies'} of {recorded.card_count}
              {recorded.card_count === 1 ? 'card' : 'cards'}.
            </p>
            <Button variant="ghost" disabled={undoing} onclick={undo}>
              {undoing ? 'Undoing…' : 'Undo'}
            </Button>
          </div>
        {/if}

        {#if generating}
          <p class="text-sm text-muted" role="status">
            Building the sheets{progress ? ` — ${progress.drawn} of ${progress.total} cards` : ''}…
          </p>
        {/if}

        <div>
          <Button disabled={generating || summary.cards === 0} onclick={generate}>
            {generating ? 'Building…' : 'Generate PDF'}
          </Button>
        </div>
      </section>
    {/if}
  {/if}
</div>
