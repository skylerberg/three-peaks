<script lang="ts">
  import {
    DECK_QUANTITY_LIMITS,
    DEFAULT_PAGE_SIZE_ID,
    DEFAULT_PRINTER_MARGIN_MM,
    PAGE_SIZES,
    PRINTER_MARGIN_LIMITS,
    PRINT_DPI,
    type CardSize,
    type FlipEdge,
    type TileGrid,
    type TileSize,
    deckCardSize,
    effectiveDpi,
    isLiveCard,
    matchingCardPreset,
    pageSize,
    planGrid,
    planRuns,
    planTiles,
    summarizeRuns,
    summarizeTiles,
    tilesWantBlankBacks,
  } from '@three-peaks/shared';
  import type { components as ApiComponents } from '@three-peaks/shared/api';
  import Button from '../components/ui/Button.svelte';
  import Spinner from '../components/ui/Spinner.svelte';
  import { ApiError, api, assertOk } from '../api/client.ts';
  import { decks } from '../lib/decks.svelte.ts';
  import { saveBlob } from '../lib/download.ts';
  import {
    type OutstandingCard,
    type PrintMode,
    type PrintRun,
    type RecordedCard,
    defaultCopies,
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
    boardId: string | null;
    punchboardId: string | null;
  }
  let { projectId, deckId, boardId, punchboardId }: Props = $props();

  // What prints as cards on a sheet: a deck's cards, or a punchboard's tokens.
  // One size, and each piece with the back it prints with -- the deck's for
  // every card of a deck, a token's own for a punchboard, null for a blank
  // reverse. Only the live ones: a deleted image has no bytes to place.
  interface PrintSet {
    id: string;
    kind: 'deck' | 'punchboard';
    name: string;
    size: CardSize;
    // The back a deck gives every card, which a punchboard has none of.
    back_file_id: string | null;
    pieces: PrintPiece[];
  }

  interface PrintPiece {
    file_id: string;
    quantity: number;
    filename: string;
    back_file_id: string | null;
  }

  const PIECES = { deck: 'cards', punchboard: 'tokens' } as const;

  // A board as this screen needs it: what it is cut to, and the artwork that is
  // still there to print. Null where the artwork was never uploaded or has been
  // deleted, which is a board with nothing to put on paper.
  interface LoadedBoard {
    id: string;
    name: string;
    size: TileSize;
    artwork: ApiComponents['schemas']['File'] | null;
  }

  let error = $state<string | null>(null);
  let loading = $state(true);
  let loaded = $state<PrintSet[]>([]);
  let boards = $state<LoadedBoard[]>([]);
  // Unticked unless the screen was opened for one. A board is several sheets of
  // a different paper from the cards, and nothing records that one has been
  // printed, so every run including every board is not a default anyone wants.
  let chosenBoards = $state<Record<string, boolean>>({});
  let expanded = $state<Record<string, boolean>>({});
  // Which cards this run puts on paper, keyed set:file, without changing what
  // the deck or punchboard holds -- its own counts are the persistent truth and
  // this is one print job's opinion. A set's own box is counted back off this
  // rather than held beside it, so the two cannot disagree.
  let included = $state<Record<string, boolean>>({});
  // And how many of each, for the cards somebody has typed a number over. Only
  // those: the deck's copy count is the default, so a key absent here is a card
  // still following it, and the mode below can move that default without
  // overwriting a number anyone chose.
  let copies = $state<Record<string, number>>({});

  // What each card and token still owes the printer, as the API works it out,
  // by the deck or punchboard it belongs to. Held beside the sets rather than
  // folded into them: it is a fact about print runs.
  let outstanding = $state<
    Record<string, { last_printed_at: string | null; cards: OutstandingCard[] }>
  >({});
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
  let mode = $state<PrintMode>('all');
  let generating = $state(false);
  let progress = $state<{ drawn: number; total: number } | null>(null);

  const uid = $props.id();
  const page = $derived(pageSize(pageId) ?? PAGE_SIZES[0]);
  const [minCopies, maxCopies] = DECK_QUANTITY_LIMITS;

  const key = (set: string, file: string) => `${set}:${file}`;

  // One lookup for the whole screen. A deck of five hundred cards is scanned
  // once here rather than once per row per recompute.
  const owed = $derived.by(() => {
    const bySet: Record<string, Record<string, OutstandingCard>> = {};
    for (const [setId, entry] of Object.entries(outstanding)) {
      bySet[setId] = Object.fromEntries(entry.cards.map((card) => [card.file_id, card]));
    }
    return bySet;
  });

  function outstandingFor(setId: string, fileId: string): OutstandingCard | undefined {
    return owed[setId]?.[fileId];
  }

  // What one card puts on paper: the number in its field, which is the plan's
  // number too -- the field is not a display of the count, it is the count.
  function printedCopies(setId: string, piece: PrintPiece): number {
    return copies[key(setId, piece.file_id)] ?? startingCopies(setId, piece);
  }

  function startingCopies(setId: string, piece: PrintPiece): number {
    return defaultCopies(piece.quantity, outstandingFor(setId, piece.file_id), mode);
  }

  function setCopies(
    setId: string,
    piece: PrintPiece,
    event: Event & { currentTarget: HTMLInputElement }
  ) {
    const typed = Number(event.currentTarget.value);
    const slot = key(setId, piece.file_id);
    if (!Number.isFinite(typed)) {
      delete copies[slot];
    } else {
      copies[slot] = Math.max(minCopies, Math.min(maxCopies, Math.round(typed)));
    }
    // Written back because a number that clamps onto the one already held
    // leaves the state unchanged, and with it the field showing what was typed
    // over a sheet that prints something else.
    event.currentTarget.value = String(printedCopies(setId, piece));
  }

  function resetCopies(set: PrintSet) {
    for (const piece of set.pieces) delete copies[key(set.id, piece.file_id)];
  }

  function selectAll(event: FocusEvent & { currentTarget: HTMLInputElement }) {
    event.currentTarget.select();
  }

  // Only what is ticked, with the version each card is drawn at carried
  // alongside -- the same number the run is recorded with, so the ledger names
  // the artwork that went through the printer.
  const runEntries = $derived(
    loaded
      .map((set) => ({
        set,
        cards: set.pieces
          .filter((piece) => included[key(set.id, piece.file_id)] === true)
          .map((piece) => ({
            file_id: piece.file_id,
            back_file_id: piece.back_file_id,
            copies: printedCopies(set.id, piece),
            state: outstandingFor(set.id, piece.file_id),
          }))
          .filter((card) => card.copies > 0),
      }))
      .filter((entry) => entry.cards.length > 0)
  );

  const runDecks = $derived(
    runEntries.map((entry) => ({
      name: entry.set.name,
      card: entry.set.size,
      back_file_id: entry.set.back_file_id,
      cards: entry.cards.map((card) => ({
        file_id: card.file_id,
        copies: card.copies,
        back_file_id: card.back_file_id,
      })),
    }))
  );

  // Every version this screen knows about, backs included, so the document is
  // drawn from the same artwork the counts above were worked out against.
  const versions = $derived.by(() => {
    const pinned: Record<string, number> = {};
    for (const entry of Object.values(outstanding)) {
      for (const card of entry.cards) {
        pinned[card.file_id] = card.version_number;
        if (card.back_file_id !== null && card.back_version_number !== null) {
          pinned[card.back_file_id] = card.back_version_number;
        }
      }
    }
    return pinned;
  });

  // What to write down once the file exists. A card the outstanding read did
  // not name has no version to record, so it is left out rather than recorded
  // at a number nobody checked -- it simply stays owed.
  const recordable = $derived(
    runEntries.flatMap((entry) =>
      entry.cards.flatMap((card): RecordedCard[] => {
        const state = card.state;
        if (state === undefined) return [];
        const back =
          includeBacks && state.back_file_id !== null && state.back_version_number !== null
            ? { back_file_id: state.back_file_id, back_version_number: state.back_version_number }
            : {};
        return [
          {
            file_id: card.file_id,
            version_number: state.version_number,
            copies: card.copies,
            ...back,
          },
        ];
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

  // "12 cards and 30 tokens", counted off the run the summary is planned from.
  const piecesLabel = $derived.by(() => {
    const count = (kind: PrintSet['kind']) =>
      runEntries
        .filter((entry) => entry.set.kind === kind)
        .reduce((sum, entry) => sum + entry.cards.reduce((n, card) => n + card.copies, 0), 0);
    const tokens = count('punchboard');
    const cards = summary.cards - tokens;
    const phrase = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    if (tokens === 0) return phrase(cards, 'card', 'cards');
    if (cards === 0) return phrase(tokens, 'token', 'tokens');
    return `${phrase(cards, 'card', 'cards')} and ${phrase(tokens, 'token', 'tokens')}`;
  });

  const anyBacks = $derived(
    runDecks.some((entry) => entry.cards.some((card) => card.back_file_id !== null))
  );

  const boardGrids = $derived(
    Object.fromEntries(
      boards.map((board) => [board.id, planTiles(page, board.size, printerMargin, cutMarks)])
    ) as Record<string, TileGrid>
  );

  const runBoards = $derived(
    boards.flatMap((board) =>
      chosenBoards[board.id] === true && board.artwork !== null
        ? [{ name: board.name, file_id: board.artwork.id, ...board.size }]
        : []
    )
  );

  const boardSummary = $derived(
    summarizeTiles(
      runBoards,
      page,
      printerMargin,
      cutMarks,
      tilesWantBlankBacks(includeBacks, summary.sheets)
    )
  );

  const nothingToPrint = $derived(summary.cards === 0 && boardSummary.pages === 0);

  function boardPages(grid: TileGrid): string {
    if (grid.pages === 0) return 'no room on this paper';
    if (grid.pages === 1) return grid.rotated ? '1 page, on its side' : '1 page';
    return `${grid.pages} pages, ${grid.columns} across by ${grid.rows} down`;
  }

  // The coarser of the two axes when the artwork is cropped to cover the board,
  // and the finer when it is shrunk to fit inside: whichever one decides the
  // scale it is drawn at.
  function boardDpi(board: LoadedBoard): number | null {
    const art = board.artwork;
    if (!art || art.image_width === null || art.image_height === null) return null;
    const across = effectiveDpi(art.image_width, board.size.width_mm);
    const down = effectiveDpi(art.image_height, board.size.height_mm);
    return fit === 'fill' ? Math.min(across, down) : Math.max(across, down);
  }

  // Every set's box, counted off its own pieces: checked when the whole set is
  // ticked, mixed when part of it is, and nothing to tick at all when it holds
  // none. `typed` is what puts the reset beside it, and is counted here rather
  // than scanned for separately.
  const setChoice = $derived.by(() => {
    const counted: Record<string, { total: number; chosen: number; typed: boolean }> = {};
    for (const set of loaded) {
      counted[set.id] = {
        total: set.pieces.length,
        chosen: set.pieces.filter((piece) => included[key(set.id, piece.file_id)] === true).length,
        typed: set.pieces.some((piece) => copies[key(set.id, piece.file_id)] !== undefined),
      };
    }
    return counted;
  });

  const anySelected = $derived(Object.values(setChoice).some((choice) => choice.chosen > 0));
  const deckSets = $derived(loaded.filter((set) => set.kind === 'deck'));
  const punchboardSets = $derived(loaded.filter((set) => set.kind === 'punchboard'));

  function chooseWholeSet(set: PrintSet, choose: boolean) {
    for (const piece of set.pieces) included[key(set.id, piece.file_id)] = choose;
  }

  $effect(() => {
    const project = projectId;
    const preselect = deckId ?? punchboardId;
    const board = boardId;
    loading = true;
    error = null;

    void (async () => {
      try {
        await decks.loadList(project);
        const list = decks.decks;
        const [full, pending, listed, punched] = await Promise.all([
          Promise.all(list.map((deck) => decks.readDeck(deck.id))),
          readOutstanding(project),
          api.GET('/api/components', { params: { query: { project_id: project, kind: 'board' } } }),
          api.GET('/api/components', {
            params: { query: { project_id: project, kind: 'punchboard' } },
          }),
        ]);
        // A card whose image is deleted has no bytes to place, so it is not a card
        // of the deck as far as a print run is concerned; nor is a token's, and a
        // back of its own that is deleted prints nothing.
        loaded = [
          ...full.map(({ deck, cards }) => ({
            id: deck.id,
            kind: 'deck' as const,
            name: deck.name,
            size: deckCardSize(deck),
            back_file_id: deck.back_file_id,
            pieces: cards.filter(isLiveCard).map((card) => ({
              file_id: card.file_id,
              quantity: card.quantity,
              filename: card.file.filename,
              back_file_id: deck.back_file_id,
            })),
          })),
          ...assertOk(punched).components.flatMap((component) =>
            component.settings.kind === 'punchboard'
              ? [
                  {
                    id: component.id,
                    kind: 'punchboard' as const,
                    name: component.name,
                    size: {
                      width_mm: component.settings.token_width_mm,
                      height_mm: component.settings.token_height_mm,
                    },
                    back_file_id: null,
                    pieces: component.tokens.filter(isLiveCard).map((token) => ({
                      file_id: token.file_id,
                      quantity: token.quantity,
                      filename: token.file.filename,
                      back_file_id:
                        token.back_file?.deleted_at === null ? token.back_file.id : null,
                    })),
                  },
                ]
              : []
          ),
        ];
        boards = assertOk(listed).components.flatMap((component) => {
          if (component.settings.kind !== 'board') return [];
          const artwork = component.files.find((entry) => entry.role === 'artwork')?.file ?? null;
          return [
            {
              id: component.id,
              name: component.name,
              size: {
                width_mm: component.settings.width_mm,
                height_mm: component.settings.height_mm,
              },
              artwork: artwork !== null && artwork.deleted_at === null ? artwork : null,
            },
          ];
        });
        outstanding = pending;
        recorded = null;
        copies = {};
        // Opened for one board is opened for that board alone: the cards are a
        // different job on different paper. Opened for nothing, every deck is
        // ticked; a punchboard is ticked only when it was asked for, since its
        // tokens are a sheet of their own nobody prints by default.
        included = Object.fromEntries(
          loaded
            .filter(
              (set) =>
                board === null && (preselect === null ? set.kind === 'deck' : preselect === set.id)
            )
            .flatMap((set) => set.pieces.map((piece) => [key(set.id, piece.file_id), true]))
        );
        chosenBoards = board === null ? {} : { [board]: true };
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

  function perSheet(set: PrintSet): number {
    return planGrid(page, set.size, printerMargin).per_sheet;
  }

  function when(timestamp: string): string {
    return new Date(timestamp).toLocaleString();
  }

  function sizeLabel(size: CardSize): string {
    const preset = matchingCardPreset(size);
    return preset ? preset.name : `${size.width_mm} × ${size.height_mm} mm`;
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
        { decks: runDecks, boards: runBoards, options, versions: $state.snapshot(versions) },
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
        Cards and punchboard tokens packed onto {page.name} at their real size, with a mirrored backing
        page behind every sheet. Print double-sided at 100% scale — never “fit to page”. A board prints
        on one side, split across pages when it is larger than one.
      </p>
    </div>

    {#if loading}
      <Spinner label="Loading decks" />
    {:else if loaded.length === 0 && boards.length === 0}
      <p class="text-sm text-muted">
        This project has no decks, punchboards or boards yet.
        <a class="focus-ring rounded underline" href="/projects/{projectId}/decks">Make a deck</a>
        or
        <a class="focus-ring rounded underline" href="/projects/{projectId}/components/board">
          a board</a
        >.
      </p>
    {:else}
      <section class="flex flex-col gap-2">
        <h2 class="text-lg font-semibold">What to print</h2>
        {#if deckSets.length > 0}
          <ul class="flex flex-col gap-2" aria-label="Decks">
            {#each deckSets as set (set.id)}
              {@render setRow(set)}
            {/each}
          </ul>
        {/if}

        {#if punchboardSets.length > 0}
          <h3 class="pt-2 text-sm font-medium">Punchboards</h3>
          <ul class="flex flex-col gap-2" aria-label="Punchboards">
            {#each punchboardSets as set (set.id)}
              {@render setRow(set)}
            {/each}
          </ul>
        {/if}

        {#if boards.length > 0}
          <h3 class="pt-2 text-sm font-medium">Boards</h3>
          <ul class="flex flex-col gap-2" aria-label="Boards">
            {#each boards as board (board.id)}
              {@const grid = boardGrids[board.id]}
              {@const dpi = boardDpi(board)}
              <li
                class="flex flex-wrap items-center gap-3 rounded-md border border-edge bg-surface p-3"
              >
                <label class="flex min-h-11 min-w-0 flex-1 items-center gap-3">
                  <input
                    type="checkbox"
                    class="focus-ring size-4"
                    checked={chosenBoards[board.id] === true && board.artwork !== null}
                    disabled={board.artwork === null}
                    onchange={(event) => (chosenBoards[board.id] = event.currentTarget.checked)}
                  />
                  <span class="min-w-0 flex-1 truncate font-medium">{board.name}</span>
                </label>
                <span class="text-sm text-muted">
                  {board.size.width_mm} × {board.size.height_mm} mm
                </span>
                {#if board.artwork === null}
                  <span class="text-sm text-warning">no artwork yet</span>
                {:else}
                  <span class="text-sm text-muted">{boardPages(grid)}</span>
                  {#if dpi !== null && dpi < PRINT_DPI}
                    <span class="text-sm text-warning">{Math.round(dpi)} DPI at this size</span>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
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
            Changed means a card or token nothing has printed yet, artwork that has been updated
            since it was last printed, a back that has been replaced, or a copy count that has gone
            up. It fills in the count beside each one; one you set yourself stays as you set it.
            Boards are not tracked: a ticked board prints every time.
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
              Millimetres your printer will not print inside. Raise it if the outer row comes out
              clipped: 6.35 suits most printers that cannot print borderless.
            </p>
          </div>
        </div>
      </section>

      <section class="flex flex-col gap-3 rounded-md border border-edge bg-surface p-4">
        {#if loaded.length > 0}
          <p class="text-sm" role="status">
            {piecesLabel} on {summary.sheets}
            {summary.sheets === 1 ? 'sheet' : 'sheets'} of {page.name}{summary.sizes > 1
              ? `, across ${summary.sizes} sizes`
              : ''}.
          </p>
        {/if}
        {#if boardSummary.pieces > 0 || loaded.length === 0}
          <p class="text-sm" role="status">
            {boardSummary.pieces}
            {boardSummary.pieces === 1 ? 'board' : 'boards'} on {boardSummary.pages}
            {boardSummary.pages === 1 ? 'page' : 'pages'} of {page.name}{boardSummary.blank_pages >
            0
              ? ', each followed by a blank page so a double-sided job leaves its back empty'
              : ''}.
          </p>
        {/if}
        {#if boardSummary.pages > 0}
          <p class="text-sm text-muted">
            Cut each piece out {cutMarks ? 'at its corner marks' : 'along the edge of its artwork'}
            and tape the pieces edge to edge.
          </p>
        {/if}

        {#if summary.oversized}
          <p class="text-sm text-danger" role="alert">
            Something selected is larger than the printable area. Lower the printer margin or choose
            a smaller size.
          </p>
        {/if}
        {#if boardSummary.unplaceable}
          <p class="text-sm text-danger" role="alert">
            The printer margin leaves no room on this paper for a board. Lower it to print one.
          </p>
        {/if}
        {#if includeBacks && !anyBacks && summary.cards > 0}
          <p class="text-sm text-warning">
            Nothing selected has a back, so the backing pages would be blank.
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
            Building the sheets{progress ? ` — ${progress.drawn} of ${progress.total}` : ''}…
          </p>
        {/if}

        <div>
          <Button disabled={generating || nothingToPrint} onclick={generate}>
            {generating ? 'Building…' : 'Generate PDF'}
          </Button>
        </div>
      </section>
    {/if}
  {/if}
</div>

{#snippet setRow(set: PrintSet)}
  {@const sheetful = perSheet(set)}
  {@const printedAt = outstanding[set.id]?.last_printed_at ?? null}
  {@const choice = setChoice[set.id]!}
  {@const many = PIECES[set.kind]}
  <li class="rounded-md border border-edge bg-surface p-3">
    <div class="flex flex-wrap items-center gap-3">
      <label class="flex min-h-11 min-w-0 flex-1 items-center gap-3">
        <input
          type="checkbox"
          class="focus-ring size-4"
          checked={choice.total > 0 && choice.chosen === choice.total}
          indeterminate={choice.chosen > 0 && choice.chosen < choice.total}
          disabled={choice.total === 0}
          onchange={(event) => chooseWholeSet(set, event.currentTarget.checked)}
        />
        <span class="min-w-0 flex-1 truncate font-medium">{set.name}</span>
      </label>
      {#if choice.chosen > 0 && choice.chosen < choice.total}
        <span class="text-sm text-muted">{choice.chosen} of {choice.total} {many}</span>
      {/if}
      <span class="text-sm text-muted">{sizeLabel(set.size)}</span>
      <span class="text-sm text-muted">
        {sheetful > 0 ? `${sheetful} per sheet` : 'too large for this paper'}
      </span>
      <span class="text-sm text-muted">
        {#if printedAt}
          last printed <time datetime={printedAt}>{when(printedAt)}</time>
        {:else}
          never printed
        {/if}
      </span>
      {#if set.kind === 'deck' && set.back_file_id === null}
        <span class="text-sm text-warning">no back</span>
      {/if}
      {#if choice.typed}
        <Button
          variant="ghost"
          aria-label="Reset the counts for {set.name}"
          onclick={() => resetCopies(set)}
        >
          Reset counts
        </Button>
      {/if}
      <Button
        variant="ghost"
        aria-expanded={expanded[set.id] === true}
        onclick={() => (expanded[set.id] = !expanded[set.id])}
      >
        {expanded[set.id] ? `Hide ${many}` : `Choose ${many}`}
      </Button>
    </div>

    {#if expanded[set.id]}
      <ul class="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto border-t border-edge pt-2">
        {#each set.pieces as piece (piece.file_id)}
          {@const label = outstandingLabel(outstandingFor(set.id, piece.file_id))}
          <li class="flex min-h-11 items-center gap-3 rounded px-2 text-sm hover:bg-accent-soft">
            <label class="flex min-w-0 flex-1 items-center gap-3">
              <input
                type="checkbox"
                class="focus-ring size-4"
                checked={included[key(set.id, piece.file_id)] === true}
                onchange={(event) => {
                  included[key(set.id, piece.file_id)] = event.currentTarget.checked;
                }}
              />
              <span class="min-w-0 flex-1 truncate">{piece.filename}</span>
            </label>
            {#if label}
              <span class="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-xs text-accent">
                {label}
              </span>
            {/if}
            <span class="text-muted" aria-hidden="true">×</span>
            <input
              type="number"
              aria-label="Copies of {piece.filename}"
              class="focus-ring min-h-11 w-20 shrink-0 rounded-md border border-edge bg-surface px-2 text-sm"
              value={printedCopies(set.id, piece)}
              min={minCopies}
              max={maxCopies}
              step="1"
              disabled={included[key(set.id, piece.file_id)] !== true}
              onfocus={selectAll}
              onchange={(event) => setCopies(set.id, piece, event)}
            />
          </li>
        {:else}
          <li class="px-2 text-sm text-muted">This {set.kind} has no {many}.</li>
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}
