import '../api/testUtils.ts';
import { fetchMock, jsonResponse } from '../api/testUtils.ts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeckAsOf from './DeckAsOf.svelte';
import { deckHistory } from '../lib/deckHistory.svelte.ts';

const PROJECT = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';
const DECK = '3c7f1b2e-9a4d-4c6b-8e1f-2a3b4c5d6e7f';
const RUN = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const FILE_A = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const FILE_B = '8b7c6d5e-4f3a-4b2c-9d1e-0f9a8b7c6d5e';

interface AsOfCard {
  card_id: string;
  file_id: string;
  name: string;
  file_version_number: number | null;
  page_number: number | null;
  last_run_id: string;
  outcome: string;
  image_deleted_at: string | null;
}

function card(overrides: Partial<AsOfCard> = {}): AsOfCard {
  return {
    card_id: 'card-1',
    file_id: FILE_A,
    name: 'Ace of coins',
    file_version_number: 2,
    page_number: 1,
    last_run_id: RUN,
    outcome: 'updated',
    image_deleted_at: null,
    ...overrides,
  };
}

let body: unknown = null;
let status = 200;

function downloads(): string[] {
  return fetchMock.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : (call[0] as Request).url))
    .filter((url) => url.includes('/download'));
}

function asOf(cards: AsOfCard[], purged = false) {
  return {
    run: {
      id: RUN,
      import_id: 'import-1',
      status: 'finished',
      source_label: 'Deck export.zip',
      page_count: cards.length,
      started_by: 'someone',
      started_at: '2026-02-01T09:00:00.000Z',
      finished_at: '2026-02-01T09:01:00.000Z',
      counts: {
        pages: cards.length,
        added: cards.length,
        updated: 0,
        unchanged: 0,
        removed: 0,
        restored: 0,
      },
    },
    cards,
    has_purged_history: purged,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  deckHistory.reset();
  status = 200;
  body = asOf([card()]);
  const statics = URL as unknown as Record<string, unknown>;
  statics.createObjectURL = vi.fn(() => 'blob:http://localhost/thumb');
  statics.revokeObjectURL = vi.fn();

  fetchMock.mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/download')) {
      return new Response('bytes', { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url.includes(`/import/runs/${RUN}/deck`)) return jsonResponse(status, body);
    return jsonResponse(404, { error: `nothing stubbed for ${url}` });
  });
});

afterEach(() => {
  const statics = URL as unknown as Record<string, unknown>;
  delete statics.createObjectURL;
  delete statics.revokeObjectURL;
});

function open() {
  return render(DeckAsOf, { projectId: PROJECT, deckId: DECK, runId: RUN });
}

describe('The deck as it stood', () => {
  it('shows every card at the version that import left it', async () => {
    body = asOf([
      card({ card_id: 'card-1', name: 'Ace of coins', file_version_number: 3 }),
      card({
        card_id: 'card-2',
        name: 'Two of cups',
        file_id: FILE_B,
        file_version_number: 1,
        page_number: 2,
      }),
    ]);
    open();

    await waitFor(() => expect(downloads()).toHaveLength(2));
    expect(downloads().some((url) => url.includes(`${FILE_A}/download?version=3`))).toBe(true);
    expect(downloads().some((url) => url.includes(`${FILE_B}/download?version=1`))).toBe(true);
    expect(screen.getByText('Version 3')).toBeInTheDocument();
    expect(screen.getByText('Version 1')).toBeInTheDocument();
  });

  it('says some artwork was permanently deleted when the ledger says so', async () => {
    body = asOf([card()], true);
    open();

    await waitFor(() => expect(screen.getByText(/permanently deleted/u)).toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('cannot be shown');
  });

  // A card still in the deck whose image someone has since deleted: it was
  // there then, and deleting the image does not take it out of the deck.
  it('says a tombstone stamped after this import is one since it', async () => {
    body = asOf([card({ image_deleted_at: '2026-03-04T10:00:00.000Z' })]);
    open();

    await waitFor(() => expect(screen.getByText('Deleted since this import')).toBeInTheDocument());
  });

  // Current state read as a claim about the past is the one thing this feature
  // exists to prevent: this image was already a tombstone when the import ran.
  it('does not call a tombstone older than this import a deletion since it', async () => {
    body = asOf([card({ image_deleted_at: '2026-01-15T10:00:00.000Z' })]);
    open();

    await waitFor(() => expect(screen.getByText('Deleted before this import')).toBeInTheDocument());
    expect(screen.queryByText(/since this import/u)).not.toBeInTheDocument();
  });

  // The route answers only for a finished run, so this is the shape of answer
  // nothing should be able to send. If one arrives, the badge drops the claim
  // rather than inventing an anchor for it.
  it('drops the comparison when the run it is anchored to has no finish', async () => {
    const unfinished = asOf([card({ image_deleted_at: '2026-03-04T10:00:00.000Z' })]);
    body = { ...unfinished, run: { ...unfinished.run, finished_at: null } };
    open();

    await waitFor(() => expect(screen.getByText('Deleted')).toBeInTheDocument());
    expect(screen.queryByText(/this import/u)).not.toBeInTheDocument();
  });

  it('says nothing about deletion for a card whose image is still there', async () => {
    body = asOf([card()]);
    open();

    await waitFor(() => expect(screen.getByText('Version 2')).toBeInTheDocument());
    expect(screen.queryByText(/Deleted/u)).not.toBeInTheDocument();
  });

  it("shows the server's reason instead of a deck for a run that is still open", async () => {
    status = 409;
    body = { error: 'That import is still running. Finish it before asking what it left' };
    open();

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('That import is still running')
    );
    expect(downloads()).toHaveLength(0);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('draws nothing for a card whose version the ledger never recorded', async () => {
    body = asOf([card({ file_version_number: null })]);
    open();

    await waitFor(() =>
      expect(screen.getByText('The version this import left is not recorded.')).toBeInTheDocument()
    );
    expect(downloads()).toHaveLength(0);
  });
  // The whole point of this screen is the artwork as it stood, so the viewer it
  // opens has to be pinned the same way the grid behind it is.
  it('opens a card at the version that import left, not at today\u2019s artwork', async () => {
    body = asOf([card({ card_id: 'card-1', name: 'Ace of coins', file_version_number: 3 })]);
    open();

    const trigger = await screen.findByRole('button', { name: 'View Ace of coins' });
    await fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Ace of coins' })).toBeInTheDocument();
    expect(within(dialog).getByText('1 of 1 \u00b7 Version 3')).toBeInTheDocument();
    await waitFor(() => expect(downloads().length).toBeGreaterThan(1));
    expect(downloads().every((url) => url.includes('/download?version=3'))).toBe(true);
  });
});
