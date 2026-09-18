import '../api/testUtils.ts';
import { fetchMock, jsonResponse } from '../api/testUtils.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { decks } from './decks.svelte.ts';

const PROJECT = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';
const DECK = '3c7f1b2e-9a4d-4c6b-8e1f-2a3b4c5d6e7f';

function deck(overrides: Record<string, unknown> = {}) {
  return {
    id: DECK,
    project_id: PROJECT,
    name: 'Base game',
    card_width_mm: 63,
    card_height_mm: 88,
    back_file_id: null,
    deleted_at: null,
    created_by: 'someone',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    card_count: 0,
    total_copies: 0,
    ...overrides,
  };
}

function card(fileId: string, quantity: number, position: number) {
  return {
    file_id: fileId,
    quantity,
    position,
    file: {
      id: fileId,
      project_id: PROJECT,
      folder_id: null,
      deck_id: DECK,
      component_id: null,
      component_role: null,
      filename: `${fileId}.png`,
      content_type: 'image/png',
      byte_size: 10,
      image_width: 744,
      image_height: 1039,
      name_locked: false,
      uploaded_by: 'someone',
      deleted_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('DeckStore', () => {
  beforeEach(() => {
    decks.reset();
    fetchMock.mockReset();
  });

  it('loads a deck and its cards together', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(200, {
        deck: deck({ card_count: 2, total_copies: 4 }),
        cards: [card('a', 3, 0), card('b', 1, 1)],
      })
    );

    await decks.loadDeck(DECK);
    expect(decks.deck?.total_copies).toBe(4);
    expect(decks.cards.map((entry) => entry.file_id)).toEqual(['a', 'b']);
  });

  // Two loads are routinely in flight at once: the one a screen starts on mount
  // and the one a realtime event starts. Only the newest may assign.
  it('discards a deck response a newer request has superseded', async () => {
    let releaseFirst: (() => void) | null = null;
    const firstArrived = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    fetchMock
      .mockImplementationOnce(async () => {
        await firstArrived;
        return jsonResponse(200, { deck: deck({ name: 'Stale' }), cards: [] });
      })
      .mockImplementationOnce(async () =>
        jsonResponse(200, { deck: deck({ name: 'Fresh' }), cards: [card('a', 1, 0)] })
      );

    const stale = decks.loadDeck(DECK);
    const fresh = decks.loadDeck(DECK);

    await fresh;
    expect(decks.deck?.name).toBe('Fresh');

    releaseFirst!();
    await stale;

    expect(decks.deck?.name).toBe('Fresh');
    expect(decks.cards).toHaveLength(1);
  });

  // Reloading the list happens on every realtime event for the project. It must
  // not cancel the deck the editor is showing, which is why the two have
  // generations of their own.
  it('leaves the open deck alone when the list reloads', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(200, { deck: deck({ name: 'Open' }), cards: [card('a', 1, 0)] })
    );
    await decks.loadDeck(DECK);

    fetchMock.mockImplementationOnce(async () => jsonResponse(200, { decks: [deck()] }));
    await decks.loadList(PROJECT);

    expect(decks.deck?.name).toBe('Open');
    expect(decks.cards).toHaveLength(1);
  });

  it('does not assign into a store that was reset mid-flight', async () => {
    let release: (() => void) | null = null;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });

    fetchMock.mockImplementationOnce(async () => {
      await arrived;
      return jsonResponse(200, { deck: deck(), cards: [card('a', 1, 0)] });
    });

    const inFlight = decks.loadDeck(DECK);
    decks.reset();
    release!();
    await inFlight;

    expect(decks.deck).toBeNull();
    expect(decks.cards).toEqual([]);
  });

  // The response is what the screen then shows, so a save that reorders is not
  // followed by a second request to find out what happened.
  it('takes the saved list back from the server rather than keeping its own', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(200, { deck: deck(), cards: [card('a', 1, 0)] })
    );
    await decks.loadDeck(DECK);

    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(200, {
        deck: deck({ card_count: 2, total_copies: 5 }),
        cards: [card('b', 4, 0), card('a', 1, 1)],
      })
    );
    await decks.saveCards(DECK, [
      { file_id: 'b', quantity: 4 },
      { file_id: 'a', quantity: 1 },
    ]);

    expect(decks.cards.map((entry) => entry.file_id)).toEqual(['b', 'a']);
    expect(decks.deck?.total_copies).toBe(5);
  });

  it('sends the cards as plain data rather than a state proxy', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(200, { deck: deck(), cards: [card('a', 2, 0)] })
    );

    await decks.saveCards(DECK, [{ file_id: 'a', quantity: 2 }]);

    const request = fetchMock.mock.calls[0][0] as Request;
    expect(await request.clone().json()).toEqual({ cards: [{ file_id: 'a', quantity: 2 }] });
  });

  it('clears the saving flag when a save is refused', async () => {
    fetchMock.mockImplementationOnce(async () => jsonResponse(422, { error: 'nope' }));
    await expect(decks.saveCards(DECK, [])).rejects.toThrow();
    expect(decks.saving).toBe(false);
  });

  describe('applying what an event carried', () => {
    async function loaded() {
      fetchMock.mockImplementationOnce(async () =>
        jsonResponse(200, { deck: deck(), cards: [card('a', 1, 0)] })
      );
      await decks.loadDeck(DECK);
    }

    it('takes the deck and its cards without a request', async () => {
      await loaded();
      fetchMock.mockReset();

      decks.applyDeckUpdate(deck({ name: 'Renamed', updated_at: '2026-02-01T00:00:00.000Z' }), [
        card('a', 4, 0),
        card('b', 1, 1),
      ]);

      expect(decks.deck?.name).toBe('Renamed');
      expect(decks.cards.map((entry) => entry.quantity)).toEqual([4, 1]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('takes the cards a rename carried, which are the ones it already had', async () => {
      await loaded();

      decks.applyDeckUpdate(deck({ name: 'Renamed', updated_at: '2026-02-01T00:00:00.000Z' }), [
        card('a', 1, 0),
      ]);

      expect(decks.deck?.name).toBe('Renamed');
      expect(decks.cards.map((entry) => entry.file_id)).toEqual(['a']);
    });

    it('updates the row in the listing too', async () => {
      fetchMock.mockImplementationOnce(async () =>
        jsonResponse(200, { decks: [deck({ name: 'Base game' })] })
      );
      await decks.loadList(PROJECT);

      decks.applyDeckUpdate(deck({ name: 'Renamed', updated_at: '2026-02-01T00:00:00.000Z' }), []);

      expect(decks.decks[0].name).toBe('Renamed');
    });

    // Deleting a deck is soft now, so it comes back through an update rather
    // than a create -- and a tab sitting on the list would otherwise have to
    // reload to see it.
    it('puts a restored deck back in the listing it had left', async () => {
      fetchMock.mockImplementationOnce(async () => jsonResponse(200, { decks: [] }));
      await decks.loadList(PROJECT);
      expect(decks.decks).toHaveLength(0);

      decks.applyDeckUpdate(deck({ updated_at: '2026-02-01T00:00:00.000Z' }), []);
      expect(decks.decks.map((row) => row.id)).toEqual([DECK]);
    });

    it('leaves a deck it has never seen out while that deck is deleted', async () => {
      fetchMock.mockImplementationOnce(async () => jsonResponse(200, { decks: [] }));
      await decks.loadList(PROJECT);

      decks.applyDeckUpdate(deck({ deleted_at: '2026-02-01T00:00:00.000Z' }), []);
      expect(decks.decks).toHaveLength(0);
    });

    it('ignores an event for a deck that is not the one open', async () => {
      await loaded();

      decks.applyDeckUpdate(deck({ id: 'another', name: 'Not this one' }), []);

      expect(decks.deck?.name).toBe('Base game');
    });

    // Applying answers no request, so it is outside the generation counters. A
    // GET issued before the edit committed lands after it and would otherwise
    // put the screen back on the row the edit replaced.
    it('does not let a response older than what was applied overwrite it', async () => {
      await loaded();

      let release: (() => void) | null = null;
      const issued = new Promise<void>((resolve) => {
        release = resolve;
      });

      // The refresh answers with the row as it stood before the edit the event
      // carried, which is what a GET issued a moment earlier would return.
      fetchMock.mockImplementationOnce(async () => {
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return jsonResponse(200, {
          deck: deck({ name: 'Stale', updated_at: '2026-01-01T00:00:00.000Z' }),
          cards: [card('a', 1, 0)],
        });
      });

      const load = decks.refreshDeck();
      await issued;
      decks.applyDeckUpdate(deck({ name: 'Applied', updated_at: '2026-03-01T00:00:00.000Z' }), [
        card('a', 9, 0),
      ]);
      await load;

      expect(decks.deck?.name).toBe('Applied');
      expect(decks.cards[0].quantity).toBe(9);
      expect(decks.loadingDeck).toBe(false);
    });
  });
});
