import '../api/testUtils.ts';
import { fetchMock, jsonResponse } from '../api/testUtils.ts';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Print from './Print.svelte';
import { decks } from '../lib/decks.svelte.ts';

interface Job {
  decks: { cards: { file_id: string; copies: number }[] }[];
  boards: { name: string; file_id: string; width_mm: number; height_mm: number }[];
  versions: Record<string, number>;
}

const generatePrintPdf = vi.fn(async (_job: Job) => new Blob(['pdf']));
const saveBlob = vi.fn((_blob: Blob, _filename: string) => {});

vi.mock('../lib/print/index.ts', () => ({
  generatePrintPdf: (job: Job) => generatePrintPdf(job),
}));
vi.mock('../lib/download.ts', () => ({
  saveBlob: (blob: Blob, filename: string) => saveBlob(blob, filename),
}));

const PROJECT = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';
const DECK = '3c7f1b2e-9a4d-4c6b-8e1f-2a3b4c5d6e7f';
const RUN = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const FRESH = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const STALE = '8b7c6d5e-4f3a-4b2c-9d1e-0f9a8b7c6d5e';
const BACK = '7c6d5e4f-3a2b-4c1d-8e0f-9a8b7c6d5e4f';

function file(id: string, filename: string) {
  return {
    id,
    project_id: PROJECT,
    folder_id: null,
    deck_id: DECK,
    component_id: null,
    component_role: null,
    filename,
    content_type: 'image/png',
    byte_size: 128,
    image_width: 750,
    image_height: 1050,
    name_locked: false,
    uploaded_by: 'someone',
    created_at: '2026-02-01T09:00:00.000Z',
    updated_at: '2026-02-01T09:00:00.000Z',
    deleted_at: null,
  };
}

const deck = {
  id: DECK,
  project_id: PROJECT,
  name: 'Base game',
  card_width_mm: 63,
  card_height_mm: 88,
  back_file_id: BACK,
  created_by: 'someone',
  created_at: '2026-02-01T09:00:00.000Z',
  updated_at: '2026-02-01T09:00:00.000Z',
  deleted_at: null,
  card_count: 2,
  total_copies: 3,
};

const cards = [
  { file_id: STALE, quantity: 2, position: 0, file: file(STALE, 'ace.png') },
  { file_id: FRESH, quantity: 1, position: 1, file: file(FRESH, 'two.png') },
  { file_id: BACK, quantity: 0, position: 2, file: file(BACK, 'back.png') },
];

// The ace has been re-imported since it was last printed; the two is square with
// the printer; the back is held at no copies, the way an import leaves it.
function outstanding() {
  return {
    decks: [
      {
        deck_id: DECK,
        back_file_id: BACK,
        back_version_number: 1,
        last_printed_at: '2026-02-02T10:00:00.000Z',
        cards: [
          {
            file_id: STALE,
            version_number: 3,
            quantity: 2,
            printed_copies: 0,
            owed_copies: 2,
            printed_version_number: 2,
            last_printed_at: '2026-02-02T10:00:00.000Z',
            reason: 'artwork',
          },
          {
            file_id: FRESH,
            version_number: 1,
            quantity: 1,
            printed_copies: 1,
            owed_copies: 0,
            printed_version_number: 1,
            last_printed_at: '2026-02-02T10:00:00.000Z',
            reason: null,
          },
          {
            file_id: BACK,
            version_number: 1,
            quantity: 0,
            printed_copies: 0,
            owed_copies: 0,
            printed_version_number: null,
            last_printed_at: null,
            reason: null,
          },
        ],
      },
    ],
  };
}

const BOARD = '4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c1b';
const BOARD_ART = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

// A board as the components listing answers with it. 500 mm square is six
// sheets of Letter, three across by two down.
function board(overrides: { name?: string; artwork?: Record<string, unknown> | null } = {}) {
  const artwork =
    overrides.artwork === null
      ? []
      : [
          {
            role: 'artwork',
            file: {
              ...file(BOARD_ART, 'main.png'),
              deck_id: null,
              component_id: BOARD,
              component_role: 'artwork',
              image_width: 5906,
              image_height: 5906,
              ...overrides.artwork,
            },
          },
        ];
  return {
    id: BOARD,
    project_id: PROJECT,
    kind: 'board',
    name: overrides.name ?? 'Main board',
    position: 0,
    settings: {
      kind: 'board',
      width_mm: 500,
      height_mm: 500,
      thickness_mm: 2,
      fold: 'bifold',
      fold_gap_mm: 3,
      edge_color: '#1f2933',
      seed: 1,
    },
    created_by: 'someone',
    created_at: '2026-02-01T09:00:00.000Z',
    updated_at: '2026-02-01T09:00:00.000Z',
    deleted_at: null,
    files: artwork,
    missing_roles: [],
  };
}

let recorded: unknown[] = [];
let deleted: string[] = [];
let listedBoards: ReturnType<typeof board>[] = [];
let listedDecks = [deck];

beforeEach(() => {
  fetchMock.mockReset();
  generatePrintPdf.mockClear();
  saveBlob.mockClear();
  decks.reset();
  recorded = [];
  deleted = [];
  listedBoards = [];
  listedDecks = [deck];

  fetchMock.mockImplementation(async (input, init) => {
    const request = typeof input === 'string' ? null : (input as Request);
    const url = typeof input === 'string' ? input : request!.url;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();

    if (url.includes('/api/print/outstanding')) return jsonResponse(200, outstanding());
    if (url.includes('/api/print/runs/')) {
      deleted.push(url.split('/').pop()!);
      return new Response(null, { status: 204 });
    }
    if (url.includes('/api/print/runs') && method === 'POST') {
      recorded.push(JSON.parse(String(init?.body ?? (await request!.text()))));
      return jsonResponse(201, {
        id: RUN,
        project_id: PROJECT,
        created_by: 'someone',
        created_at: '2026-02-03T10:00:00.000Z',
        card_count: 1,
        copies: 2,
      });
    }
    if (url.includes('/api/components')) return jsonResponse(200, { components: listedBoards });
    if (url.includes(`/api/decks/${DECK}`)) return jsonResponse(200, { deck, cards });
    if (url.includes('/api/decks')) return jsonResponse(200, { decks: listedDecks });
    return jsonResponse(404, { error: `nothing stubbed for ${url}` });
  });
});

function open(boardId: string | null = null) {
  return render(Print, { projectId: PROJECT, deckId: boardId === null ? DECK : null, boardId });
}

async function chooseChanged() {
  const mode = await screen.findByLabelText('What to print');
  await fireEvent.change(mode, { target: { value: 'changed' } });
}

function job(): Job {
  return generatePrintPdf.mock.calls[0][0];
}

describe('choosing what goes on paper', () => {
  async function openCards() {
    await fireEvent.click(await screen.findByRole('button', { name: 'Choose cards' }));
  }

  function deckBox(): HTMLInputElement {
    return screen.getByRole('checkbox', { name: 'Base game' });
  }

  function cardBox(filename: string): HTMLInputElement {
    return screen.getByRole('checkbox', { name: new RegExp(filename) });
  }

  it('reports the deck as mixed while only some of its cards are ticked', async () => {
    open();
    await openCards();
    expect(deckBox().checked).toBe(true);
    expect(deckBox().indeterminate).toBe(false);

    await fireEvent.click(cardBox('ace.png'));
    await waitFor(() => expect(deckBox().indeterminate).toBe(true));
    expect(deckBox().checked).toBe(false);
    expect(screen.getByText('2 of 3 cards')).toBeInTheDocument();

    await fireEvent.click(cardBox('ace.png'));
    await waitFor(() => expect(deckBox().checked).toBe(true));
    expect(deckBox().indeterminate).toBe(false);
  });

  it('clears the whole deck from its own box, and ticks it back', async () => {
    open();
    await openCards();

    await fireEvent.click(deckBox());
    await waitFor(() => expect(cardBox('ace.png').checked).toBe(false));
    expect(cardBox('two.png').checked).toBe(false);
    expect(screen.getByRole('button', { name: 'Generate PDF' })).toBeDisabled();

    await fireEvent.click(deckBox());
    await waitFor(() => expect(cardBox('ace.png').checked).toBe(true));
    expect(cardBox('two.png').checked).toBe(true);
    expect(deckBox().checked).toBe(true);
  });

  // A mixed box ticks the rest rather than clearing what is already there --
  // the way an unchecked one behaves, which is what the browser hands the
  // handler.
  it('ticks the rest of the deck from a mixed box', async () => {
    open();
    await openCards();
    await fireEvent.click(cardBox('ace.png'));
    await waitFor(() => expect(deckBox().indeterminate).toBe(true));

    await fireEvent.click(deckBox());
    await waitFor(() => expect(cardBox('ace.png').checked).toBe(true));
    expect(deckBox().checked).toBe(true);
    expect(deckBox().indeterminate).toBe(false);
  });

  it('prints only the cards left ticked', async () => {
    open();
    await openCards();
    await fireEvent.click(cardBox('ace.png'));
    await waitFor(() => expect(deckBox().indeterminate).toBe(true));

    await fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));
    await waitFor(() => expect(generatePrintPdf).toHaveBeenCalled());
    expect(job().decks[0].cards).toEqual([{ file_id: FRESH, copies: 1 }]);
  });
});

// A deleted card keeps its row in the deck so a restore is exact, and nothing
// about a print run is any of its business.
describe('a card whose image is deleted', () => {
  const GONE = '6d5e4f3a-2b1c-4d0e-9f8a-7b6c5d4e3f2a';

  beforeEach(() => {
    const otherwise = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes(`/api/decks/${DECK}`)) {
        const gone = { ...file(GONE, 'retired.png'), deleted_at: '2026-02-02T09:00:00.000Z' };
        return jsonResponse(200, {
          deck,
          cards: [...cards, { file_id: GONE, quantity: 4, position: 3, file: gone }],
        });
      }
      return otherwise(input, init);
    });
  });

  it('is neither listed nor counted towards its deck', async () => {
    open();
    await fireEvent.click(await screen.findByRole('button', { name: 'Choose cards' }));
    await screen.findByText('ace.png');

    expect(screen.queryByText('retired.png')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/^3 cards on/u);

    await fireEvent.click(screen.getByRole('checkbox', { name: /ace\.png/u }));
    expect(await screen.findByText('2 of 3 cards')).toBeInTheDocument();
  });

  it('puts nothing of it on the sheets', async () => {
    open();
    await fireEvent.click(await screen.findByRole('button', { name: 'Generate PDF' }));

    await waitFor(() => expect(generatePrintPdf).toHaveBeenCalled());
    expect(job().decks[0].cards.map((card) => card.file_id)).toEqual([STALE, FRESH]);
  });
});

describe('how many of each card', () => {
  async function openCards() {
    await fireEvent.click(await screen.findByRole('button', { name: 'Choose cards' }));
  }

  function countFor(filename: string): HTMLInputElement {
    return screen.getByLabelText(`Copies of ${filename}`);
  }

  async function setCount(filename: string, value: string) {
    await fireEvent.change(countFor(filename), { target: { value } });
  }

  it('starts every card at the count its deck holds', async () => {
    open();
    await openCards();
    expect(countFor('ace.png').value).toBe('2');
    expect(countFor('two.png').value).toBe('1');
    // The back is a card row the deck keeps none of, and starts there.
    expect(countFor('back.png').value).toBe('0');
  });

  it('prints the count somebody typed rather than the deck’s', async () => {
    open();
    await openCards();
    await setCount('ace.png', '5');

    await fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));
    await waitFor(() => expect(generatePrintPdf).toHaveBeenCalled());
    expect(job().decks[0].cards).toEqual([
      { file_id: STALE, copies: 5 },
      { file_id: FRESH, copies: 1 },
    ]);
  });

  it('records the run at the count that went through the printer', async () => {
    open();
    await openCards();
    await setCount('ace.png', '5');
    await fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));

    await waitFor(() => expect(recorded).toHaveLength(1));
    const body = recorded[0] as { cards: { file_id: string; copies: number }[] };
    expect(body.cards.find((card) => card.file_id === STALE)?.copies).toBe(5);
  });

  it('leaves out a card set to no copies', async () => {
    open();
    await openCards();
    await setCount('ace.png', '0');

    await fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));
    await waitFor(() => expect(generatePrintPdf).toHaveBeenCalled());
    expect(job().decks[0].cards).toEqual([{ file_id: FRESH, copies: 1 }]);
  });

  it('prints a card the deck holds none of once its count is typed over', async () => {
    open();
    await openCards();
    await setCount('back.png', '1');

    await fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));
    await waitFor(() => expect(generatePrintPdf).toHaveBeenCalled());
    expect(job().decks[0].cards).toContainEqual({ file_id: BACK, copies: 1 });
  });

  // Clamped onto the number already held, which is the case the field is written
  // back for: the state does not change, so nothing re-renders it, and the
  // number left on screen would be one no sheet is packed from.
  it('holds a typed count to what the deck may ask for', async () => {
    open();
    await openCards();
    await setCount('ace.png', '999');
    await waitFor(() => expect(countFor('ace.png').value).toBe('999'));

    await setCount('ace.png', '4000');
    expect(countFor('ace.png').value).toBe('999');

    await setCount('ace.png', '0');
    await waitFor(() => expect(countFor('ace.png').value).toBe('0'));
    await setCount('ace.png', '-3');
    expect(countFor('ace.png').value).toBe('0');
  });

  // The mode moves the default under every card still following it, and leaves
  // a number somebody chose exactly where they put it.
  it('keeps a typed count when the mode changes', async () => {
    open();
    await openCards();
    await setCount('ace.png', '5');
    await chooseChanged();

    await waitFor(() => expect(countFor('two.png').value).toBe('0'));
    expect(countFor('ace.png').value).toBe('5');
  });

  it('puts a deck’s counts back where the mode wants them', async () => {
    open();
    await openCards();
    await setCount('ace.png', '5');

    const reset = await screen.findByRole('button', { name: 'Reset the counts for Base game' });
    await fireEvent.click(reset);
    await waitFor(() => expect(countFor('ace.png').value).toBe('2'));
    expect(
      screen.queryByRole('button', { name: 'Reset the counts for Base game' })
    ).not.toBeInTheDocument();
  });

  it('offers no reset until a count has been typed over', async () => {
    open();
    await openCards();
    expect(
      screen.queryByRole('button', { name: 'Reset the counts for Base game' })
    ).not.toBeInTheDocument();
  });

  it('leaves the count of an unticked card alone', async () => {
    open();
    await openCards();
    await fireEvent.click(screen.getByRole('checkbox', { name: /ace.png/ }));
    await waitFor(() => expect(countFor('ace.png').disabled).toBe(true));
  });
});

describe('printing only what has changed', () => {
  it('says when each deck was last printed and why a card is owed', async () => {
    open();
    await waitFor(() => expect(screen.getAllByText(/last printed/).length).toBeGreaterThan(0));

    await fireEvent.click(screen.getByRole('button', { name: 'Choose cards' }));
    expect(await screen.findByText('new artwork')).toBeInTheDocument();

    // The card the printer is already square with carries no badge at all.
    expect(screen.queryByText('never printed')).not.toBeInTheDocument();
  });

  it('leaves out the cards already on paper at their current artwork', async () => {
    open();
    await chooseChanged();

    await waitFor(() =>
      expect(
        screen.getByText('2 cards on 2 sheets of US Letter (8.5 × 11 in).')
      ).toBeInTheDocument()
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));

    await waitFor(() => expect(generatePrintPdf).toHaveBeenCalled());
    expect(job().decks[0].cards).toEqual([{ file_id: STALE, copies: 2 }]);
  });

  it('prints every selected card when the mode is everything', async () => {
    open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate PDF' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));

    await waitFor(() => expect(generatePrintPdf).toHaveBeenCalled());
    expect(job().decks[0].cards).toEqual([
      { file_id: STALE, copies: 2 },
      { file_id: FRESH, copies: 1 },
    ]);
  });

  it('draws every card at the version it records, backs included', async () => {
    open();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate PDF' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));

    await waitFor(() => expect(generatePrintPdf).toHaveBeenCalled());
    expect(job().versions).toEqual({ [STALE]: 3, [FRESH]: 1, [BACK]: 1 });
  });

  it('records the run, then takes it back', async () => {
    open();
    await chooseChanged();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate PDF' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));

    await waitFor(() => expect(recorded).toHaveLength(1));
    expect(saveBlob).toHaveBeenCalled();
    expect(recorded[0]).toEqual({
      project_id: PROJECT,
      cards: [
        {
          file_id: STALE,
          version_number: 3,
          copies: 2,
          back_file_id: BACK,
          back_version_number: 1,
        },
      ],
    });

    const undo = await screen.findByRole('button', { name: 'Undo' });
    await fireEvent.click(undo);
    await waitFor(() => expect(deleted).toEqual([RUN]));
  });

  it('records no back when the backing pages are left out', async () => {
    open();
    const backs = await screen.findByLabelText('Include backing pages');
    await fireEvent.click(backs);
    await fireEvent.click(screen.getByRole('button', { name: 'Generate PDF' }));

    await waitFor(() => expect(recorded).toHaveLength(1));
    const body = recorded[0] as { cards: Record<string, unknown>[] };
    expect(body.cards.every((card) => card.back_file_id === undefined)).toBe(true);
  });
});

// A board is one piece of artwork at a size of its own, and the only thing on
// this screen that can be larger than the paper.
describe('printing a board', () => {
  function boardBox(name = 'Main board'): HTMLInputElement {
    return screen.getByRole('checkbox', { name });
  }

  async function generate(): Promise<Job> {
    const button = screen.getByRole('button', { name: 'Generate PDF' });
    await waitFor(() => expect(button).toBeEnabled());
    await fireEvent.click(button);
    await waitFor(() => expect(generatePrintPdf).toHaveBeenCalled());
    return job();
  }

  it('says how big a board is and how many pages it is split across', async () => {
    listedBoards = [board()];
    open();

    const row = (await screen.findByRole('checkbox', { name: 'Main board' })).closest('li')!;
    expect(row).toHaveTextContent('500 × 500 mm');
    expect(row).toHaveTextContent('6 pages, 3 across by 2 down');
  });

  // Every deck is ticked when the screen opens and no board is: a board is a
  // different job on different paper, and nothing records that one was printed.
  it('leaves a board out of the run until it is ticked', async () => {
    listedBoards = [board()];
    open();

    await screen.findByRole('checkbox', { name: 'Main board' });
    expect(boardBox().checked).toBe(false);
    expect((await generate()).boards).toEqual([]);
  });

  it('hands a ticked board to the document at the size it is cut to', async () => {
    listedBoards = [board()];
    open();

    await fireEvent.click(await screen.findByRole('checkbox', { name: 'Main board' }));
    await waitFor(() => expect(boardBox().checked).toBe(true));
    expect(screen.getByText(/1\s+board on 6\s+pages/)).toBeInTheDocument();

    expect((await generate()).boards).toEqual([
      { name: 'Main board', file_id: BOARD_ART, width_mm: 500, height_mm: 500 },
    ]);
  });

  // The bleed goes with the marks, so without them the ink stops at the cut
  // and the edge of the artwork is the line.
  it('says where to cut, which without marks is the edge of the artwork', async () => {
    listedBoards = [board()];
    open(BOARD);

    await waitFor(() => expect(screen.getByText(/at its corner marks/)).toBeVisible());
    await fireEvent.click(screen.getByLabelText('Cut marks'));
    await waitFor(() => expect(screen.getByText(/along the edge of its artwork/)).toBeVisible());
  });

  it('opens on one board alone when the link names it', async () => {
    listedBoards = [board()];
    open(BOARD);

    await waitFor(() => expect(boardBox().checked).toBe(true));
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Base game' }).checked).toBe(
      false
    );

    const sent = await generate();
    expect(sent.decks).toEqual([]);
    expect(sent.boards).toHaveLength(1);
    // Nothing is written down for a board: the ledger is cards.
    expect(recorded).toEqual([]);
  });

  // The printer turns every sheet over for the cards, so a board in the same
  // document needs an empty page behind each of its own.
  it('counts a blank page behind each board page only beside card backs', async () => {
    listedBoards = [board()];
    open();

    await fireEvent.click(await screen.findByRole('checkbox', { name: 'Main board' }));
    await waitFor(() => expect(screen.getByText(/each followed by a blank page/)).toBeVisible());

    await fireEvent.click(screen.getByLabelText('Include backing pages'));
    await waitFor(() => expect(screen.queryByText(/each followed by a blank page/)).toBeNull());
  });

  it('offers nothing to tick on a board whose artwork is deleted', async () => {
    listedBoards = [board({ artwork: { deleted_at: '2026-02-04T09:00:00.000Z' } })];
    open();

    const box = await screen.findByRole<HTMLInputElement>('checkbox', { name: 'Main board' });
    expect(box.disabled).toBe(true);
    expect(box.closest('li')).toHaveTextContent('no artwork yet');
  });

  it('offers nothing to tick on a board still waiting for its artwork', async () => {
    listedBoards = [board({ artwork: null })];
    open();

    await screen.findByRole('checkbox', { name: 'Main board' });
    expect(boardBox().disabled).toBe(true);
  });

  // 1890 px across 500 mm is what Canva exports a board as unless it is asked
  // for more, and it is the number that says to ask.
  it('says when the artwork is coarser than a printer wants', async () => {
    listedBoards = [board({ artwork: { image_width: 1890, image_height: 1890 } })];
    open();

    const row = (await screen.findByRole('checkbox', { name: 'Main board' })).closest('li')!;
    expect(row).toHaveTextContent('96 DPI at this size');
  });

  it('lists the boards of a project that has no decks', async () => {
    listedBoards = [board()];
    listedDecks = [];
    open(BOARD);

    await waitFor(() => expect(boardBox().checked).toBe(true));
    expect(screen.getByText(/1\s+board on 6\s+pages/)).toBeInTheDocument();
    expect(screen.queryByText(/sheets of US Letter/)).toBeNull();
  });
});
