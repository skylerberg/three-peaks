import '../api/testUtils.ts';
import { fetchMock, jsonResponse } from '../api/testUtils.ts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeckRun from './DeckRun.svelte';
import { deckHistory } from '../lib/deckHistory.svelte.ts';

const PROJECT = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';
const DECK = '3c7f1b2e-9a4d-4c6b-8e1f-2a3b4c5d6e7f';
const RUN = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const FILE_A = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const FILE_B = '8b7c6d5e-4f3a-4b2c-9d1e-0f9a8b7c6d5e';
const FILE_C = '7c6d5e4f-3a2b-4c1d-8e0f-9a8b7c6d5e4f';

interface CardRow {
  file_id: string | null;
  file_version_number: number | null;
  matched_by: string | null;
  name: string;
  outcome: string;
  page_number: number | null;
  restored: boolean;
}

function card(overrides: Partial<CardRow> = {}): CardRow {
  return {
    file_id: FILE_A,
    file_version_number: 1,
    matched_by: 'identity',
    name: 'Ace of coins',
    outcome: 'updated',
    page_number: 1,
    restored: false,
    ...overrides,
  };
}

let cards: CardRow[] = [];

function detail() {
  return {
    run: {
      id: RUN,
      import_id: 'import-1',
      status: 'finished',
      source_label: 'Deck export.zip',
      page_count: 3,
      started_by: 'someone',
      started_at: '2026-02-01T09:00:00.000Z',
      finished_at: '2026-02-01T09:01:00.000Z',
      counts: { pages: 3, added: 1, updated: 1, unchanged: 1, removed: 1, restored: 0 },
    },
    cards,
  };
}

function downloads(): string[] {
  return fetchMock.mock.calls
    .map((call) => (typeof call[0] === 'string' ? call[0] : (call[0] as Request).url))
    .filter((url) => url.includes('/download'));
}

beforeEach(() => {
  fetchMock.mockReset();
  deckHistory.reset();
  cards = [];
  const statics = URL as unknown as Record<string, unknown>;
  statics.createObjectURL = vi.fn(() => 'blob:http://localhost/thumb');
  statics.revokeObjectURL = vi.fn();

  fetchMock.mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/download')) {
      return new Response('bytes', { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url.includes(`/api/decks/${DECK}/import/runs/${RUN}`)) return jsonResponse(200, detail());
    return jsonResponse(404, { error: `nothing stubbed for ${url}` });
  });
});

afterEach(() => {
  const statics = URL as unknown as Record<string, unknown>;
  delete statics.createObjectURL;
  delete statics.revokeObjectURL;
});

function open() {
  return render(DeckRun, { projectId: PROJECT, deckId: DECK, runId: RUN });
}

describe('What one import changed', () => {
  it('puts the cards this import removed above the rest', async () => {
    cards = [
      card({ outcome: 'unchanged', name: 'Two of cups', file_id: FILE_B }),
      card({ outcome: 'added', name: 'Three of swords', file_id: FILE_C, matched_by: null }),
      card({ outcome: 'removed', name: 'Ace of coins' }),
    ];
    open();

    await waitFor(() => expect(screen.getByText('Removed (1)')).toBeInTheDocument());
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((node) => node.textContent?.trim());
    expect(headings[0]).toBe('Removed (1)');
    expect(headings[1]).toBe('Added (1)');
  });

  it('names the tier each card was matched on, the strongest included', async () => {
    cards = [
      card({ name: 'Ace of coins', matched_by: 'page_id' }),
      card({ name: 'Two of cups', file_id: FILE_B, matched_by: 'identity' }),
      card({ name: 'Three of swords', file_id: FILE_C, matched_by: 'page_number' }),
    ];
    open();

    await waitFor(() => expect(screen.getByText('matched by Canva page')).toBeInTheDocument());
    expect(screen.getByText('matched by page name')).toBeInTheDocument();
    expect(screen.getByText('matched by page number')).toBeInTheDocument();
  });

  it('collapses unchanged rows behind a summary', async () => {
    cards = [
      card({ outcome: 'unchanged', name: 'Two of cups', file_id: FILE_B }),
      card({ outcome: 'added', name: 'Three of swords', file_id: FILE_C, matched_by: null }),
    ];
    const view = open();

    await waitFor(() => expect(screen.getByText('1 unchanged')).toBeInTheDocument());
    const details = view.container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
  });

  // The lie this whole screen exists to prevent: yesterday's row drawn with
  // today's artwork.
  it('asks for each thumbnail at the version this run left', async () => {
    cards = [
      card({ name: 'Ace of coins', file_version_number: 4 }),
      card({ outcome: 'added', name: 'Two of cups', file_id: FILE_B, file_version_number: 1 }),
    ];
    open();

    await waitFor(() => expect(downloads()).toHaveLength(2));
    expect(downloads().some((url) => url.includes(`${FILE_A}/download?version=4`))).toBe(true);
    expect(downloads().some((url) => url.includes(`${FILE_B}/download?version=1`))).toBe(true);
  });

  it('names a purged card instead of drawing a broken thumbnail', async () => {
    cards = [
      card({ outcome: 'removed', name: 'Gone for good', file_id: null, file_version_number: null }),
    ];
    open();

    await waitFor(() => expect(screen.getByText('Gone for good')).toBeInTheDocument());
    expect(screen.getByText('This image has been permanently deleted.')).toBeInTheDocument();
    expect(downloads()).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Version history' })).not.toBeInTheDocument();
  });

  it('links each card to its own version history', async () => {
    cards = [card({ name: 'Ace of coins' })];
    open();

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Version history' })).toHaveAttribute(
        'href',
        `/projects/${PROJECT}/files/${FILE_A}/versions`
      )
    );
  });
  // The response arrives in one order and this screen draws it in another, with
  // the removed cards lifted to the top. The arrow keys follow the screen.
  it('walks the cards in the order the sections draw them', async () => {
    cards = [
      card({ outcome: 'unchanged', name: 'Two of cups', file_id: FILE_B }),
      card({ outcome: 'added', name: 'Three of swords', file_id: FILE_C, matched_by: null }),
      card({ outcome: 'removed', name: 'Ace of coins', matched_by: 'page_id' }),
    ];
    open();

    const trigger = await screen.findByRole('button', { name: /^View Ace of coins/u });
    await fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Ace of coins' })).toBeInTheDocument();
    expect(within(dialog).getByText('1 of 3 \u00b7 matched by Canva page')).toBeInTheDocument();

    await fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(
      within(screen.getByRole('dialog')).getByRole('heading', { name: 'Three of swords' })
    ).toBeInTheDocument();
  });

  // A card nothing can draw is a stop the arrow keys would land on with an
  // empty frame.
  it('leaves a purged card out of the viewer', async () => {
    cards = [
      card({ outcome: 'removed', name: 'Gone for good', file_id: null, file_version_number: null }),
      card({ outcome: 'added', name: 'Three of swords', file_id: FILE_C, matched_by: null }),
    ];
    open();

    const trigger = await screen.findByRole('button', { name: /^View Three of swords/u });
    await fireEvent.click(trigger);

    expect(within(screen.getByRole('dialog')).getByText(/^1 of 1/u)).toBeInTheDocument();
  });
});
