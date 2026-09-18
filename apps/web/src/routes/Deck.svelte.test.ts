import '../api/testUtils.ts';
import { FakeWebSocket, fetchMock, jsonResponse } from '../api/testUtils.ts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCES, TRIGGERS } from 'svelte-dnd-action';
import Deck from './Deck.svelte';
import { deckImports } from '../lib/deckImports.svelte.ts';
import { decks, isLiveCard } from '../lib/decks.svelte.ts';
import { realtime } from '../lib/realtime.svelte.ts';

const PROJECT = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';
const DECK = '3c7f1b2e-9a4d-4c6b-8e1f-2a3b4c5d6e7f';

// Longer than the screen's own coalesce window, on real timers: the render and
// the events both go through microtasks the fake clock does not drive.
const AFTER_THE_WINDOW_MS = 600;

// Long enough for an effect to have re-run and read the bytes again, short
// enough that a green run says so quickly.
const SETTLE_MS = 100;

const DECK_ROW = {
  id: DECK,
  project_id: PROJECT,
  name: 'Base game',
  card_width_mm: 63,
  card_height_mm: 88,
  back_file_id: null,
  created_by: 'someone',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  card_count: 0,
  total_copies: 0,
};

const OBJECT_URL = 'blob:http://localhost/thumb';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cardFile(n: number) {
  return {
    id: `1111111a-2222-4333-8444-00000000000${n}`,
    project_id: PROJECT,
    folder_id: null,
    filename: `card-${n}.png`,
    content_type: 'image/png',
    byte_size: 10,
    image_width: 1000,
    image_height: 1400,
    name_locked: false,
    uploaded_by: 'someone',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
  };
}

// Over the wire, so the rows are the brand-new objects a real response carries
// rather than the ones the caller already holds.
function deckPayload(quantities: number[], backFileId: string | null = null): string {
  return JSON.stringify({
    deck: { ...DECK_ROW, back_file_id: backFileId },
    cards: quantities.map((quantity, index) => {
      const file = cardFile(index + 1);
      return { file_id: file.id, quantity, position: index, file };
    }),
  });
}

function stubDeckWithCards(backFileId: string | null = null): void {
  fetchMock.mockImplementation(async (input, init) => {
    // openapi-fetch hands fetch a Request rather than an init, and the PUT and
    // the GET share a path here.
    const request = typeof input === 'string' ? null : (input as Request);
    const url = request?.url ?? (input as string);
    const method = request?.method ?? (init as RequestInit | undefined)?.method ?? 'GET';
    if (url.includes('/download')) {
      return new Response('bytes', { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url.includes(`/api/decks/${DECK}/import`)) {
      return jsonResponse(404, { error: 'This deck has no import' });
    }
    if (backFileId && url.endsWith(`/api/files/${backFileId}`)) {
      return jsonResponse(200, { ...cardFile(9), id: backFileId, filename: 'back.png' });
    }
    if (url.includes(`/api/decks/${DECK}/cards`) && method === 'PUT') {
      return new Response(deckPayload([3, 1, 1], backFileId), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes(`/api/decks/${DECK}`)) {
      return new Response(deckPayload([1, 1, 1], backFileId), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes(`/api/projects/${PROJECT}`)) {
      return jsonResponse(200, {
        id: PROJECT,
        name: 'Colori',
        description: null,
        role: 'editor',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    return jsonResponse(404, { error: `nothing stubbed for ${url}` });
  });
}

// The same deck seen by somebody who cannot edit it: the handles, the copy
// fields and the row's own buttons are all the editor's.
function stubDeckAsViewer(): void {
  stubDeckWithCards();
  const withCards = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes(`/api/projects/${PROJECT}`)) {
      return jsonResponse(200, {
        id: PROJECT,
        name: 'Colori',
        description: null,
        role: 'viewer',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    return withCards(input, init);
  });
}

// One live card and one whose image has been deleted, which is a deck the
// editor has to keep working in: the row stays in the list, marked.
function stubDeckWithDeletedCard(backFileId: string | null = null): void {
  const live = cardFile(1);
  const gone = { ...cardFile(2), deleted_at: '2026-02-01T00:00:00.000Z' };
  const payload = JSON.stringify({
    deck: { ...DECK_ROW, back_file_id: backFileId },
    cards: [live, gone].map((file, index) => ({
      file_id: file.id,
      quantity: 1,
      position: index,
      file,
    })),
  });

  fetchMock.mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes('/download')) {
      return new Response('bytes', { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url.includes(`/api/decks/${DECK}/import`)) {
      return jsonResponse(404, { error: 'This deck has no import' });
    }
    if (backFileId && url.endsWith(`/api/files/${backFileId}`)) {
      return jsonResponse(200, gone);
    }
    if (url.includes(`/api/decks/${DECK}`)) {
      return new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes(`/api/projects/${PROJECT}`)) {
      return jsonResponse(200, {
        id: PROJECT,
        name: 'Colori',
        description: null,
        role: 'editor',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    return jsonResponse(404, { error: `nothing stubbed for ${url}` });
  });
}

// Three cards with the middle one's image deleted, and a save answered with the
// list it was sent, the way the server answers one -- so what the screen draws
// after a save is what the save asked for.
function stubDeckWithDeletedMiddle(): void {
  const files = [
    cardFile(1),
    { ...cardFile(2), deleted_at: '2026-02-01T00:00:00.000Z' },
    cardFile(3),
  ];
  const rows = (list: { file_id: string; quantity: number }[]) =>
    list.map((entry, position) => ({
      ...entry,
      position,
      file: files.find((file) => file.id === entry.file_id)!,
    }));
  const held = rows([
    { file_id: files[0].id, quantity: 1 },
    { file_id: files[1].id, quantity: 4 },
    { file_id: files[2].id, quantity: 2 },
  ]);

  fetchMock.mockImplementation(async (input) => {
    const request = typeof input === 'string' ? null : (input as Request);
    const url = request?.url ?? (input as string);
    if (url.includes('/download')) {
      return new Response('bytes', { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url.includes(`/api/decks/${DECK}/import`)) {
      return jsonResponse(404, { error: 'This deck has no import' });
    }
    if (url.includes(`/api/decks/${DECK}/cards`) && request?.method === 'PUT') {
      const { cards } = await request.clone().json();
      return jsonResponse(200, { deck: DECK_ROW, cards: rows(cards) });
    }
    if (url.includes(`/api/decks/${DECK}`)) {
      return jsonResponse(200, { deck: DECK_ROW, cards: held });
    }
    if (url.includes(`/api/projects/${PROJECT}`)) {
      return jsonResponse(200, {
        id: PROJECT,
        name: 'Colori',
        description: null,
        role: 'editor',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    return jsonResponse(404, { error: `nothing stubbed for ${url}` });
  });
}

function urlsRequested(): string[] {
  return fetchMock.mock.calls.map((call) =>
    typeof call[0] === 'string' ? call[0] : (call[0] as Request).url
  );
}

function thumbnailReads(): number {
  return urlsRequested().filter((url) => url.includes('/download')).length;
}

function deckLoads(): number {
  return urlsRequested().filter((url) => url.endsWith(`/api/decks/${DECK}`)).length;
}

function fileRowReads(fileId: string): number {
  return urlsRequested().filter((url) => url.endsWith(`/api/files/${fileId}`)).length;
}

// The names the rows carry, in the order they are drawn.
function drawnCards(): string[] {
  return screen
    .getAllByRole('listitem')
    .map((row) => row.getAttribute('aria-label') ?? '')
    .filter((label) => label.startsWith('card-'));
}

// Leaves the save unanswered until it is let go, which is the only way to look
// at the screen during the round trip a drop opens.
function holdTheCardsPut(): { answer: () => void } {
  stubDeckWithCards();
  const otherwise = fetchMock.getMockImplementation()!;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  fetchMock.mockImplementation(async (input, init) => {
    const request = typeof input === 'string' ? null : (input as Request);
    if (request?.method === 'PUT' && request.url.includes(`/api/decks/${DECK}/cards`)) {
      await held;
    }
    return otherwise(input, init);
  });
  return { answer: release };
}

function putsOfCards(): number {
  return fetchMock.mock.calls.filter(([input]) => {
    const request = typeof input === 'string' ? null : (input as Request);
    return request?.method === 'PUT' && request.url.includes(`/api/decks/${DECK}/cards`);
  }).length;
}

async function savedCards(): Promise<{ file_id: string; quantity: number }[] | null> {
  const call = fetchMock.mock.calls.find(([input]) => {
    const request = typeof input === 'string' ? null : (input as Request);
    return request?.method === 'PUT' && request.url.includes(`/api/decks/${DECK}/cards`);
  });
  if (!call) return null;
  return (await (call[0] as Request).clone().json()).cards;
}

function stubApi(): void {
  fetchMock.mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url.includes(`/api/decks/${DECK}/import`)) {
      return jsonResponse(404, { error: 'This deck has no import' });
    }
    if (url.includes(`/api/decks/${DECK}`)) {
      return jsonResponse(200, { deck: DECK_ROW, cards: [] });
    }
    if (url.includes(`/api/projects/${PROJECT}`)) {
      return jsonResponse(200, {
        id: PROJECT,
        name: 'Colori',
        description: null,
        role: 'editor',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    return jsonResponse(404, { error: `nothing stubbed for ${url}` });
  });
}

// The events svelte-dnd-action dispatches on the zone, which is the whole of
// what the screen sees of a drag. jsdom has no pointer, no layout and no
// animation, so the gesture itself belongs to check:reorder; what is settled
// here is what the screen does with the list it is handed.
type DragItem = { id: string; file_id: string; quantity: number };

function zone(): HTMLElement {
  return screen.getByRole('list', { name: 'Cards, in the order they print' });
}

// Off the rows the zone draws, which leave the deleted cards out.
function itemsAfterMoving(from: number, to: number): DragItem[] {
  const items = decks.cards.filter(isLiveCard).map((card) => ({ ...card, id: card.file_id }));
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  return items;
}

function dndEvent(name: string, items: DragItem[], info: Record<string, unknown>): CustomEvent {
  return new CustomEvent(name, { detail: { items, info: { id: items[0].id, ...info } } });
}

async function dropCard(from: number, to: number): Promise<void> {
  const items = itemsAfterMoving(from, to);
  await fireEvent(
    zone(),
    dndEvent('consider', items, { trigger: TRIGGERS.DRAG_STARTED, source: SOURCES.POINTER })
  );
  await fireEvent(
    zone(),
    dndEvent('finalize', items, { trigger: TRIGGERS.DROPPED_INTO_ZONE, source: SOURCES.POINTER })
  );
}

describe('Deck editor', () => {
  beforeEach(() => {
    decks.reset();
    deckImports.reset();
    fetchMock.mockReset();
    FakeWebSocket.reset();
    stubApi();
    const statics = URL as unknown as Record<string, unknown>;
    statics.createObjectURL = vi.fn(() => OBJECT_URL);
    statics.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    realtime.stop();
    const statics = URL as unknown as Record<string, unknown>;
    delete statics.createObjectURL;
    delete statics.revokeObjectURL;
  });

  // An import publishes one file event per page. That used to reload the deck
  // once per burst; now it costs no request at all, which is what the
  // coalescing window existed to limit.
  it('reads nothing back for a burst of realtime events', async () => {
    stubDeckWithCards();
    realtime.start('tok');
    FakeWebSocket.last().open();

    render(Deck, { projectId: PROJECT, deckId: DECK });
    await waitFor(() => expect(thumbnailReads()).toBe(3));

    const before = urlsRequested().length;
    for (let page = 1; page <= 20; page += 1) {
      FakeWebSocket.last().receive({
        type: 'file_updated',
        project_id: PROJECT,
        data: { ...cardFile(1), filename: `renamed-${page}.png`, actor_user_id: 'someone' },
      });
    }
    await wait(AFTER_THE_WINDOW_MS);

    expect(urlsRequested().length).toBe(before);
    // And the last one is on screen, without anything having been read. All of
    // them, because the card-back picker lists every card by name as well.
    expect(await screen.findAllByText('renamed-20.png')).not.toHaveLength(0);
  });

  // The Canva app is where an import runs, and a tab somebody closed leaves the
  // run open -- which the deck refuses every later import behind. This is the
  // only place it can be settled.
  describe('a run the Canva app left open', () => {
    const RUN = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';

    function stubOpenRun(open = true): { abandons: () => number } {
      let abandoned = !open;
      fetchMock.mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes('/abandon')) {
          abandoned = true;
          return jsonResponse(200, { id: RUN, status: 'abandoned' });
        }
        if (url.includes(`/api/decks/${DECK}/import`)) {
          return jsonResponse(200, {
            id: 'import-1',
            deck_id: DECK,
            source_label: 'Base game',
            open_run_id: abandoned ? null : RUN,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          });
        }
        if (url.includes(`/api/decks/${DECK}`)) {
          return jsonResponse(200, { deck: DECK_ROW, cards: [] });
        }
        return jsonResponse(200, {
          id: PROJECT,
          name: 'Colori',
          description: null,
          role: 'editor',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        });
      });
      return { abandons: () => urlsRequested().filter((url) => url.includes('/abandon')).length };
    }

    it('offers to discard it, and stops offering once it is discarded', async () => {
      const { abandons } = stubOpenRun();

      render(Deck, { projectId: PROJECT, deckId: DECK });
      const discard = await screen.findByRole('button', { name: 'Discard this import' });

      await fireEvent.click(discard);

      await waitFor(() => expect(abandons()).toBe(1));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Discard this import' })).toBeNull()
      );
    });

    // The open run is the whole of what this screen says about importing. A
    // deck that has been imported into before is a deck with nothing to do.
    it('says nothing once the run is settled', async () => {
      stubOpenRun(false);

      render(Deck, { projectId: PROJECT, deckId: DECK });
      await screen.findByRole('button', { name: 'Move in from Assets' });
      await waitFor(() => expect(deckImports.bindingDeckId).toBe(DECK));

      expect(screen.queryByText(/Canva/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Discard this import' })).toBeNull();
    });
  });

  // The history screen is read-only, so it is offered whether or not this
  // account may edit -- and it costs this screen no request.
  it('links to the import history whether or not this account may edit', async () => {
    for (const role of ['editor', 'viewer']) {
      fetchMock.mockReset();
      decks.reset();
      fetchMock.mockImplementation(async (input) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        if (url.includes(`/api/decks/${DECK}/import`)) {
          return jsonResponse(404, { error: 'This deck has no import' });
        }
        if (url.includes(`/api/decks/${DECK}`)) {
          return jsonResponse(200, { deck: DECK_ROW, cards: [] });
        }
        return jsonResponse(200, {
          id: PROJECT,
          name: 'Colori',
          description: null,
          role,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
        });
      });

      const view = render(Deck, { projectId: PROJECT, deckId: DECK });
      const link = await screen.findByRole('link', { name: 'Import history' });
      expect(link).toHaveAttribute('href', `/projects/${PROJECT}/decks/${DECK}/history`);

      const asked = fetchMock.mock.calls.map((call) =>
        typeof call[0] === 'string' ? call[0] : (call[0] as Request).url
      );
      expect(asked.some((url) => url.includes('/import/runs'))).toBe(false);
      view.unmount();
    }
  });

  it('offers nothing to discard on a deck nothing has imported into', async () => {
    stubApi();

    render(Deck, { projectId: PROJECT, deckId: DECK });
    await screen.findByRole('button', { name: 'Move in from Assets' });
    // Waited for, or the absence below is only the answer not having landed.
    await waitFor(() => expect(deckImports.bindingDeckId).toBe(DECK));

    expect(screen.queryByRole('button', { name: 'Discard this import' })).toBeNull();
    expect(screen.queryByText(/Canva/)).toBeNull();
  });

  // Every save sends the whole list and shows the response, so all three rows
  // come back as new objects carrying the values they already had. The keyed
  // each holds onto the DOM, and this still blanked and re-read every image in
  // the deck: each Thumbnail is handed its id through a getter over the row.
  it('does not reload the thumbnails when a copy count changes', async () => {
    stubDeckWithCards();

    render(Deck, { projectId: PROJECT, deckId: DECK });
    await waitFor(() => expect(thumbnailReads()).toBe(3));
    // The copies inputs are disabled until the role has come back.
    await screen.findByRole('button', { name: 'Move in from Assets' });

    const copies = await screen.findAllByLabelText('Copies');
    await fireEvent.change(copies[0], { target: { value: '3' } });

    // The store, not the input: the input reads 3 the moment it is typed into,
    // and it is the saved rows landing back in the store that used to flash.
    await waitFor(() => expect(decks.cards[0].quantity).toBe(3));
    await wait(SETTLE_MS);

    expect(thumbnailReads()).toBe(3);
  });

  // The input's floor is the same constant the API and the CHECK are written
  // from, so a card can be held in the deck at no copies at all. What used to
  // happen to a typed zero was a silent clamp back up to one.
  it('saves a copy count of zero as typed', async () => {
    stubDeckWithCards();

    render(Deck, { projectId: PROJECT, deckId: DECK });
    await screen.findByRole('button', { name: 'Move in from Assets' });

    const copies = await screen.findAllByLabelText('Copies');
    expect(copies[0]).toHaveAttribute('min', '0');
    await fireEvent.change(copies[0], { target: { value: '0' } });

    await waitFor(async () => expect(await savedCards()).not.toBeNull());
    expect((await savedCards())?.[0].quantity).toBe(0);
  });

  // An import titles a page Back and the deck holds it at no copies. Without
  // this the row reads as a card somebody set to zero by mistake, and the only
  // thing saying otherwise is a picker further up the screen.
  it('says which card in the list is the deck\u2019s back', async () => {
    const BACK = '1111111a-2222-4333-8444-000000000002';
    stubDeckWithCards(BACK);

    render(Deck, { projectId: PROJECT, deckId: DECK });
    await screen.findByRole('button', { name: 'Move in from Assets' });

    expect(
      await screen.findByText(/This deck.s back\. It prints on the reverse of every card/)
    ).toBeInTheDocument();
  });

  // The card back is named by id, so its row is a request of its own -- and the
  // save replaces decks.deck, which used to re-read that row every time even
  // though the id on it had not moved.
  it('does not re-read the card back when a copy count changes', async () => {
    const BACK = '1111111a-2222-4333-8444-000000000009';
    stubDeckWithCards(BACK);

    render(Deck, { projectId: PROJECT, deckId: DECK });
    await screen.findByText('back.png');
    await screen.findByRole('button', { name: 'Move in from Assets' });
    expect(fileRowReads(BACK)).toBe(1);

    const copies = await screen.findAllByLabelText('Copies');
    await fireEvent.change(copies[0], { target: { value: '3' } });

    await waitFor(() => expect(decks.cards[0].quantity).toBe(3));
    await wait(SETTLE_MS);

    expect(fileRowReads(BACK)).toBe(1);
  });

  // Deleted artwork prints nothing, so it is not a back anyone can newly pick.
  it('leaves a deleted card out of the back picker', async () => {
    stubDeckWithDeletedCard();

    render(Deck, { projectId: PROJECT, deckId: DECK });
    const picker = await screen.findByLabelText("Use one of this deck's images");

    expect([...(picker as HTMLSelectElement).options].map((option) => option.text)).toEqual([
      'No back',
      'card-1.png',
    ]);
  });

  // Unless it is the back already: dropping it would leave the picker reading
  // "No back" over a deck that has one.
  it('keeps a deleted back listed while it is the back', async () => {
    const BACK = '1111111a-2222-4333-8444-000000000002';
    stubDeckWithDeletedCard(BACK);

    render(Deck, { projectId: PROJECT, deckId: DECK });
    const picker = (await screen.findByLabelText(
      "Use one of this deck's images"
    )) as HTMLSelectElement;

    expect([...picker.options].map((option) => option.text)).toEqual([
      'No back',
      'card-1.png',
      'card-2.png',
    ]);
    expect(picker.value).toBe(BACK);
  });

  // The whole point of putting the rows on the event: the screen learns what
  // changed without asking, so a burst of edits by someone else costs this tab
  // nothing.
  it('applies a deck_updated that carries the rows instead of reading the deck back', async () => {
    stubDeckWithCards();
    realtime.start('tok');
    FakeWebSocket.last().open();

    render(Deck, { projectId: PROJECT, deckId: DECK });
    await waitFor(() => expect(thumbnailReads()).toBe(3));
    await screen.findByRole('button', { name: 'Move in from Assets' });

    const loadsBefore = deckLoads();
    FakeWebSocket.last().receive({
      type: 'deck_updated',
      project_id: PROJECT,
      data: {
        deck: { ...DECK_ROW, name: 'Renamed elsewhere', updated_at: '2026-06-01T00:00:00.000Z' },
        cards: JSON.parse(deckPayload([3, 1, 1])).cards,
        actor_user_id: 'someone-else',
      },
    });
    await wait(AFTER_THE_WINDOW_MS);

    await screen.findByRole('heading', { name: 'Renamed elsewhere' });
    expect(screen.getAllByDisplayValue('3')).toHaveLength(1);
    expect(deckLoads()).toBe(loadsBefore);
    expect(thumbnailReads()).toBe(3);
  });

  // One project holds several decks. Another one moving says nothing about this
  // one, and reading it back to discover that is the wasted request.
  it('ignores a deck_updated for another deck in the project', async () => {
    stubDeckWithCards();
    realtime.start('tok');
    FakeWebSocket.last().open();

    render(Deck, { projectId: PROJECT, deckId: DECK });
    await waitFor(() => expect(thumbnailReads()).toBe(3));

    const loadsBefore = deckLoads();
    FakeWebSocket.last().receive({
      type: 'deck_updated',
      project_id: PROJECT,
      data: {
        deck: { ...DECK_ROW, id: '9999999a-2222-4333-8444-999999999999', name: 'Another deck' },
        cards: [],
        actor_user_id: 'someone-else',
      },
    });
    await wait(AFTER_THE_WINDOW_MS);

    expect(deckLoads()).toBe(loadsBefore);
    // And this deck is untouched by it.
    expect(screen.getByRole('heading', { name: 'Base game' })).toBeInTheDocument();
  });

  // A copy count is replaced far more often than it is amended, and clicking
  // into one used to leave a caret between the digits.
  it('selects the copy count when it is focused', async () => {
    stubDeckWithCards();

    render(Deck, { projectId: PROJECT, deckId: DECK });
    // The copies inputs are disabled until the role has come back.
    await screen.findByRole('button', { name: 'Move in from Assets' });

    const copies = await screen.findAllByLabelText<HTMLInputElement>('Copies');
    const selected = vi.spyOn(copies[0], 'select');
    copies[0].focus();

    expect(selected).toHaveBeenCalled();
  });

  // Every row carries four buttons between its count and the next one, and a
  // deck is a column of numbers somebody is typing down.
  it('tabs between the copy counts rather than through the row buttons', async () => {
    stubDeckWithCards();

    render(Deck, { projectId: PROJECT, deckId: DECK });
    await screen.findByRole('button', { name: 'Move in from Assets' });

    const copies = await screen.findAllByLabelText<HTMLInputElement>('Copies');
    copies[0].focus();

    // False: the key was handled here, so the browser's own tab order never
    // reaches the buttons.
    expect(await fireEvent.keyDown(copies[0], { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(copies[1]);

    expect(await fireEvent.keyDown(copies[1], { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(copies[0]);

    // At either end there is no count to move to, and Tab does what it always
    // does.
    expect(await fireEvent.keyDown(copies[0], { key: 'Tab', shiftKey: true })).toBe(true);
    expect(await fireEvent.keyDown(copies[2], { key: 'Tab' })).toBe(true);
  });
  // A deleted card prints nothing, so the list is the deck as it comes off the
  // printer. Its row is still held, because a save that dropped it would lose
  // the place and the copy count a restore is meant to give back.
  describe('a card whose image is deleted', () => {
    const [first, gone, third] = [cardFile(1).id, cardFile(2).id, cardFile(3).id];

    async function showDeleted(): Promise<void> {
      await fireEvent.click(await screen.findByRole('button', { name: 'More card options' }));
      await fireEvent.click(
        screen.getByRole('menuitemcheckbox', { name: /Show deleted cards \(1\)/u })
      );
    }

    it('is left out of the list and the totals until it is asked for', async () => {
      stubDeckWithDeletedMiddle();
      render(Deck, { projectId: PROJECT, deckId: DECK });

      await waitFor(() => expect(drawnCards()).toEqual(['card-1.png', 'card-3.png']));
      expect(screen.getByText('2 cards · 3 to print')).toBeInTheDocument();
      expect(screen.queryByText(/Deleted\. Restore it/u)).toBeNull();

      await showDeleted();

      expect(drawnCards()).toEqual(['card-1.png', 'card-2.png', 'card-3.png']);
      expect(screen.getByText('Deleted. Restore it to print this card.')).toBeInTheDocument();
      // Showing it is not printing it.
      expect(screen.getByText('2 cards · 3 to print')).toBeInTheDocument();
    });

    it('goes back into a reorder where it was, with its copies', async () => {
      stubDeckWithDeletedMiddle();
      render(Deck, { projectId: PROJECT, deckId: DECK });
      await waitFor(() => expect(drawnCards()).toEqual(['card-1.png', 'card-3.png']));

      await dropCard(1, 0);

      await waitFor(async () =>
        expect(await savedCards()).toEqual([
          { file_id: third, quantity: 2 },
          { file_id: gone, quantity: 4 },
          { file_id: first, quantity: 1 },
        ])
      );
      // And the answer, which names it, does not put it back on screen.
      await waitFor(() => expect(decks.cards).toHaveLength(3));
      expect(drawnCards()).toEqual(['card-3.png', 'card-1.png']);
    });

    it('goes back into a copy count save', async () => {
      stubDeckWithDeletedMiddle();
      render(Deck, { projectId: PROJECT, deckId: DECK });
      await screen.findByRole('button', { name: 'Move in from Assets' });

      const copies = await screen.findAllByLabelText('Copies');
      expect(copies).toHaveLength(2);
      await fireEvent.change(copies[1], { target: { value: '5' } });

      await waitFor(async () =>
        expect(await savedCards()).toEqual([
          { file_id: first, quantity: 1 },
          { file_id: gone, quantity: 4 },
          { file_id: third, quantity: 5 },
        ])
      );
    });

    it('is skipped by the card viewer while it is hidden', async () => {
      stubDeckWithDeletedMiddle();
      render(Deck, { projectId: PROJECT, deckId: DECK });

      const [trigger] = await screen.findAllByRole('button', { name: /^View card-/u });
      await fireEvent.click(trigger);
      await fireEvent.keyDown(window, { key: 'ArrowRight' });

      expect(within(screen.getByRole('dialog')).getByRole('heading').textContent?.trim()).toBe(
        'card-3.png'
      );
    });

    // Looking is not editing, so the menu is there for anyone who can read the
    // deck.
    it('can be shown by someone who cannot edit', async () => {
      stubDeckAsViewer();
      render(Deck, { projectId: PROJECT, deckId: DECK });
      await waitFor(() => expect(decks.cards).toHaveLength(3));

      expect(screen.getByRole('button', { name: 'More card options' })).toBeInTheDocument();
    });
  });

  describe('the card options menu', () => {
    it('opens from the keyboard and gives the focus back on Escape', async () => {
      stubDeckWithDeletedMiddle();
      render(Deck, { projectId: PROJECT, deckId: DECK });
      const trigger = await screen.findByRole('button', { name: 'More card options' });
      trigger.focus();

      await fireEvent.keyDown(trigger, { key: 'ArrowDown' });

      const item = await screen.findByRole('menuitemcheckbox');
      await waitFor(() => expect(document.activeElement).toBe(item));
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(item).toHaveAttribute('aria-checked', 'false');

      await fireEvent.keyDown(item, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
      expect(document.activeElement).toBe(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('closes once an option is chosen, and says it is on when opened again', async () => {
      stubDeckWithDeletedMiddle();
      render(Deck, { projectId: PROJECT, deckId: DECK });
      const trigger = await screen.findByRole('button', { name: 'More card options' });

      await fireEvent.click(trigger);
      await fireEvent.click(screen.getByRole('menuitemcheckbox'));
      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

      await fireEvent.click(trigger);
      expect(screen.getByRole('menuitemcheckbox')).toHaveAttribute('aria-checked', 'true');
    });

    it('closes on a press anywhere else', async () => {
      stubDeckWithDeletedMiddle();
      render(Deck, { projectId: PROJECT, deckId: DECK });
      await fireEvent.click(await screen.findByRole('button', { name: 'More card options' }));
      expect(screen.getByRole('menu')).toBeInTheDocument();

      await fireEvent.pointerDown(screen.getByRole('heading', { name: 'Cards' }));

      await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    });
  });

  // A 48px square says nothing about a bleed or a typo, and the artwork is the
  // one thing this screen holds that a person came to look at.
  describe('the card viewer', () => {
    // Focused first, the way a real click leaves it: the viewer hands the focus
    // back to whatever opened it, and jsdom's click moves it nowhere by itself.
    async function openCard(position: number): Promise<HTMLElement> {
      const triggers = await screen.findAllByRole('button', { name: /^View card-/u });
      triggers[position].focus();
      await fireEvent.click(triggers[position]);
      return triggers[position];
    }

    function heading(): string {
      return within(screen.getByRole('dialog')).getByRole('heading').textContent?.trim() ?? '';
    }

    it('opens the card that was clicked and walks the deck with the arrow keys', async () => {
      stubDeckWithCards();

      render(Deck, { projectId: PROJECT, deckId: DECK });
      await openCard(0);

      expect(heading()).toBe('card-1.png');
      // What the row said and the artwork cannot: which of them this is, and
      // how many of it the deck asks for.
      expect(
        within(screen.getByRole('dialog')).getByText('1 of 3 \u00b7 1 copy')
      ).toBeInTheDocument();

      await fireEvent.keyDown(window, { key: 'ArrowRight' });
      expect(heading()).toBe('card-2.png');

      await fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(heading()).toBe('card-3.png');

      await fireEvent.keyDown(window, { key: 'ArrowLeft' });
      expect(heading()).toBe('card-2.png');
    });

    it('stops at the first and the last card rather than wrapping round', async () => {
      stubDeckWithCards();

      render(Deck, { projectId: PROJECT, deckId: DECK });
      await openCard(0);

      await fireEvent.keyDown(window, { key: 'ArrowLeft' });
      expect(heading()).toBe('card-1.png');
      expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

      for (let step = 0; step < 4; step += 1) {
        await fireEvent.keyDown(window, { key: 'ArrowRight' });
      }
      expect(heading()).toBe('card-3.png');
      expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    });

    it('closes on Escape and gives the focus back to the row that opened it', async () => {
      stubDeckWithCards();

      render(Deck, { projectId: PROJECT, deckId: DECK });
      const trigger = await openCard(1);
      expect(document.activeElement).toBe(screen.getByRole('dialog'));

      await fireEvent.keyDown(window, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(document.activeElement).toBe(trigger);
    });

    // The open card is named by id rather than by position. Held by position,
    // this would go on showing whatever the deck moved into that slot.
    it('closes when the card it is showing leaves the deck', async () => {
      stubDeckWithCards();
      realtime.start('tok');
      FakeWebSocket.last().open();

      render(Deck, { projectId: PROJECT, deckId: DECK });
      await openCard(0);
      expect(heading()).toBe('card-1.png');

      FakeWebSocket.last().receive({
        type: 'deck_updated',
        project_id: PROJECT,
        data: {
          deck: DECK_ROW,
          cards: JSON.parse(deckPayload([1, 1, 1])).cards.slice(1),
          actor_user_id: 'someone-else',
        },
      });

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });
  });

  // The arrows are gone: a card is dragged by its handle, and the list the drop
  // leaves behind is what gets saved.
  describe('reordering by drag', () => {
    beforeEach(() => {
      stubDeckWithCards();
    });

    it('saves the whole list in the order the drop left it', async () => {
      render(Deck, { projectId: PROJECT, deckId: DECK });
      await waitFor(() => expect(decks.cards).toHaveLength(3));
      const wanted = itemsAfterMoving(2, 0).map((card) => card.file_id);

      await dropCard(2, 0);

      await waitFor(async () =>
        expect((await savedCards())?.map((card) => card.file_id)).toEqual(wanted)
      );
    });

    // The drawn list is the dropped one until the save answers. Reading the
    // store back in between is what made a dropped card jump home and then
    // forward again, on every drop. Held open deliberately: with an answer that
    // arrives immediately, a screen that draws the store would still be caught
    // by the response and the assertion would pass for the wrong reason.
    it('draws the dropped order while the save is in flight', async () => {
      const save = holdTheCardsPut();
      render(Deck, { projectId: PROJECT, deckId: DECK });
      await waitFor(() => expect(decks.cards).toHaveLength(3));

      await dropCard(2, 0);
      await wait(SETTLE_MS);

      expect(drawnCards()[0]).toBe('card-3.png');
      save.answer();
    });

    it('saves nothing for a card dropped where it came from', async () => {
      render(Deck, { projectId: PROJECT, deckId: DECK });
      await waitFor(() => expect(decks.cards).toHaveLength(3));

      await dropCard(1, 1);
      await wait(SETTLE_MS);

      expect(await savedCards()).toBeNull();
    });

    // A keyboard drag finalizes on every arrow press and ends with a consider.
    // Saving on each finalize would be a request and a realtime event per
    // keystroke, all but the last of them describing an arrangement nobody
    // asked for.
    it('saves once at the end of a keyboard drag, not once per arrow', async () => {
      render(Deck, { projectId: PROJECT, deckId: DECK });
      await waitFor(() => expect(decks.cards).toHaveLength(3));

      const first = itemsAfterMoving(2, 1);
      const second = itemsAfterMoving(2, 0);
      await fireEvent(
        zone(),
        dndEvent(
          'consider',
          decks.cards.map((card) => ({ ...card, id: card.file_id })),
          {
            trigger: TRIGGERS.DRAG_STARTED,
            source: SOURCES.KEYBOARD,
          }
        )
      );
      await fireEvent(
        zone(),
        dndEvent('finalize', first, {
          trigger: TRIGGERS.DROPPED_INTO_ZONE,
          source: SOURCES.KEYBOARD,
        })
      );
      await fireEvent(
        zone(),
        dndEvent('finalize', second, {
          trigger: TRIGGERS.DROPPED_INTO_ZONE,
          source: SOURCES.KEYBOARD,
        })
      );
      await wait(SETTLE_MS);
      expect(await savedCards()).toBeNull();

      await fireEvent(
        zone(),
        dndEvent('consider', second, {
          trigger: TRIGGERS.DRAG_STOPPED,
          source: SOURCES.KEYBOARD,
        })
      );

      await waitFor(async () =>
        expect((await savedCards())?.map((card) => card.file_id)).toEqual(
          second.map((card) => card.file_id)
        )
      );
      expect(putsOfCards()).toBe(1);
    });

    it('offers no handle to someone who cannot edit', async () => {
      stubDeckAsViewer();
      render(Deck, { projectId: PROJECT, deckId: DECK });
      await waitFor(() => expect(decks.cards).toHaveLength(3));

      expect(screen.queryByLabelText('Reorder card-1.png')).toBeNull();
    });
  });
});
