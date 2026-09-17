import '../api/testUtils.ts';
import { fetchMock, jsonResponse } from '../api/testUtils.ts';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Print from './Print.svelte';
import { decks } from '../lib/decks.svelte.ts';

interface Job {
  decks: { cards: { file_id: string; copies: number }[] }[];
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

let recorded: unknown[] = [];
let deleted: string[] = [];

beforeEach(() => {
  fetchMock.mockReset();
  generatePrintPdf.mockClear();
  saveBlob.mockClear();
  decks.reset();
  recorded = [];
  deleted = [];

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
    if (url.includes(`/api/decks/${DECK}`)) return jsonResponse(200, { deck, cards });
    if (url.includes('/api/decks')) return jsonResponse(200, { decks: [deck] });
    return jsonResponse(404, { error: `nothing stubbed for ${url}` });
  });
});

function open() {
  return render(Print, { projectId: PROJECT, deckId: DECK });
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
