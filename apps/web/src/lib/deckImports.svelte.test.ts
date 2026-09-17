import '../api/testUtils.ts';
import { fetchMock, jsonResponse } from '../api/testUtils.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deckImports } from './deckImports.svelte.ts';

const PROJECT = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';
const DECK = '3c7f1b2e-9a4d-4c6b-8e1f-2a3b4c5d6e7f';
const RUN = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';
const OTHER_DECK = '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';

function binding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'import-1',
    deck_id: DECK,
    source_label: null,
    open_run_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function urlOf(input: unknown): string {
  return typeof input === 'string' ? input : (input as Request).url;
}

describe('DeckImportStore', () => {
  beforeEach(() => {
    deckImports.reset();
    fetchMock.mockReset();
  });

  // The route answers 404 both for a deck that is not bound and for a deck that
  // does not exist, and the screen has already proved the deck exists.
  it('treats a 404 from the binding route as a deck nothing has imported into', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(404, { error: 'This deck has no import' })
    );

    await deckImports.loadBinding(PROJECT, DECK);

    expect(deckImports.binding).toBeNull();
    expect(deckImports.bindingDeckId).toBe(DECK);
  });

  it('lets any other failure from the binding route through', async () => {
    fetchMock.mockImplementation(async () => jsonResponse(500, { error: 'Internal error' }));

    await expect(deckImports.loadBinding(PROJECT, DECK)).rejects.toThrow('Internal error');
  });

  it('discards a binding response that a newer request has already superseded', async () => {
    let releaseFirst: (() => void) | null = null;
    const firstArrived = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let bindings = 0;

    fetchMock.mockImplementation(async () => {
      bindings += 1;
      if (bindings === 1) {
        await firstArrived;
        return jsonResponse(200, binding({ source_label: 'stale' }));
      }
      return jsonResponse(200, binding({ source_label: 'fresh' }));
    });

    const stale = deckImports.loadBinding(PROJECT, DECK);
    await deckImports.loadBinding(PROJECT, DECK);
    releaseFirst!();
    await stale;

    expect(deckImports.binding?.source_label).toBe('fresh');
  });

  it('drops the previous deck’s binding before the next deck’s is read', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bindings = 0;

    fetchMock.mockImplementation(async () => {
      bindings += 1;
      if (bindings === 1) return jsonResponse(200, binding({ open_run_id: RUN }));
      await held;
      return jsonResponse(200, binding({ deck_id: OTHER_DECK }));
    });

    await deckImports.loadBinding(PROJECT, DECK);
    expect(deckImports.binding?.open_run_id).toBe(RUN);
    expect(deckImports.bindingDeckId).toBe(DECK);

    const next = deckImports.loadBinding(PROJECT, OTHER_DECK);
    expect(deckImports.binding).toBeNull();
    expect(deckImports.bindingDeckId).toBeNull();

    release!();
    await next;

    expect(deckImports.bindingDeckId).toBe(OTHER_DECK);
    expect(deckImports.binding?.deck_id).toBe(OTHER_DECK);
  });

  describe('the open run', () => {
    it('takes a run event for the deck it is holding', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(200, binding()));
      await deckImports.loadBinding(PROJECT, DECK);

      deckImports.applyOpenRun(DECK, RUN);
      expect(deckImports.binding?.open_run_id).toBe(RUN);

      deckImports.applyOpenRun(DECK, null);
      expect(deckImports.binding?.open_run_id).toBeNull();
    });

    // The deck had no row at all, so there was nothing to patch and the event
    // was dropped -- leaving a run the screen could not offer to discard until
    // somebody loaded it again.
    it('reads the row a first import has just created', async () => {
      let bindings = 0;
      fetchMock.mockImplementation(async () => {
        bindings += 1;
        return bindings === 1
          ? jsonResponse(404, { error: 'This deck has no import' })
          : jsonResponse(200, binding({ open_run_id: RUN }));
      });
      await deckImports.loadBinding(PROJECT, DECK);
      expect(deckImports.binding).toBeNull();

      deckImports.applyOpenRun(DECK, RUN);

      await vi.waitFor(() => expect(deckImports.binding?.open_run_id).toBe(RUN));
    });

    // Nothing to draw and nothing to clear, so a closing run on a deck with no
    // row is not worth a request.
    it('asks for nothing when a run closes on a deck it has no row for', async () => {
      fetchMock.mockImplementation(async () =>
        jsonResponse(404, { error: 'This deck has no import' })
      );
      await deckImports.loadBinding(PROJECT, DECK);
      const reads = fetchMock.mock.calls.length;

      deckImports.applyOpenRun(DECK, null);

      expect(fetchMock.mock.calls.length).toBe(reads);
    });

    // Every project's deck events reach every screen subscribed to it, and one
    // deck's run says nothing about another's.
    it('ignores a run event for a deck it is not holding', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(200, binding()));
      await deckImports.loadBinding(PROJECT, DECK);

      deckImports.applyOpenRun(OTHER_DECK, RUN);

      expect(deckImports.binding?.open_run_id).toBeNull();
    });
  });

  describe('discarding an open run', () => {
    it('abandons it and re-reads the binding, so the deck stops offering it', async () => {
      const seen: string[] = [];
      let bindings = 0;

      fetchMock.mockImplementation(async (input) => {
        const url = urlOf(input);
        seen.push(url);
        if (url.includes('/abandon')) return jsonResponse(200, { id: RUN, status: 'abandoned' });
        bindings += 1;
        return jsonResponse(200, binding({ open_run_id: bindings === 1 ? RUN : null }));
      });

      await deckImports.loadBinding(PROJECT, DECK);
      expect(deckImports.binding?.open_run_id).toBe(RUN);

      await deckImports.abandon(RUN);

      expect(seen.some((url) => url.includes(`/api/decks/import/runs/${RUN}/abandon`))).toBe(true);
      expect(deckImports.binding?.open_run_id).toBeNull();
    });

    // The screen toasts it. Swallowing it here would leave the button looking
    // as though it had worked on a run that is still open.
    it('lets a refusal through', async () => {
      fetchMock.mockImplementation(async (input) =>
        urlOf(input).includes('/abandon')
          ? jsonResponse(409, { error: 'That run is already finished' })
          : jsonResponse(200, binding({ open_run_id: RUN }))
      );

      await deckImports.loadBinding(PROJECT, DECK);

      await expect(deckImports.abandon(RUN)).rejects.toThrow('That run is already finished');
    });
  });
});
