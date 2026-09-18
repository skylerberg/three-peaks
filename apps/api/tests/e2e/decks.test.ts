import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_DECK_CARDS, cardPreset } from '@three-peaks/shared';
import { createUser, deleteUser, type TestUser } from '../setup/testContext.ts';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const poker = cardPreset('poker')!;

describe('decks', () => {
  let owner: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let projectId: string;
  let cardA: string;
  let cardB: string;
  let assetId: string;
  let foreignFileId: string;

  async function uploadTo(
    user: TestUser,
    project: string,
    filename: string,
    into: { deck_id?: string; role?: string } = {}
  ) {
    const query = new URLSearchParams({ project_id: project, filename, ...into });
    const res = await user.api.postBytes(
      `/api/files/upload?${query}`,
      PNG as unknown as BodyInit,
      'image/png'
    );
    return (await res.json()).id as string;
  }

  async function createDeck(name: string, extra: Record<string, unknown> = {}) {
    const res = await owner.api.post('/api/decks', {
      project_id: projectId,
      name,
      card_width_mm: poker.width_mm,
      card_height_mm: poker.height_mm,
      ...extra,
    });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    [owner, viewer, stranger] = await Promise.all([
      createUser('deck-owner'),
      createUser('deck-viewer'),
      createUser('deck-stranger'),
    ]);

    projectId = (await (await owner.api.post('/api/projects', { name: 'Deck project' })).json()).id;
    await owner.api.put(`/api/projects/${projectId}/members`, {
      email: viewer.email,
      role: 'viewer',
    });

    assetId = await uploadTo(owner, projectId, 'loose-asset.png');

    const foreignProject = (
      await (await stranger.api.post('/api/projects', { name: 'Elsewhere' })).json()
    ).id;
    foreignFileId = await uploadTo(stranger, foreignProject, 'foreign.png');
  });

  afterAll(async () => {
    for (const user of [owner, viewer, stranger]) await deleteUser(user);
  });

  it('creates a deck and lists it with its counts', async () => {
    const created = await createDeck('Base game');
    expect(created.status).toBe(201);
    expect(created.body.card_width_mm).toBe(63);
    expect(created.body.card_height_mm).toBe(88);
    expect(created.body.card_count).toBe(0);
    expect(created.body.total_copies).toBe(0);

    const listed = await (await owner.api.get(`/api/decks?project_id=${projectId}`)).json();
    expect(listed.decks.map((deck: { name: string }) => deck.name)).toContain('Base game');
  });

  it('refuses a second deck with the same name in one project', async () => {
    await createDeck('Promos');
    expect((await createDeck('Promos')).status).toBe(409);
  });

  it('refuses a second deck with the same name in a different case', async () => {
    await createDeck('Expansion');
    expect((await createDeck('EXPANSION')).status).toBe(409);
  });

  it('refuses a card size the studio could not offer', async () => {
    expect((await createDeck('Enormous', { card_width_mm: 5000 })).status).toBe(422);
  });

  it('refuses a card back at creation, when the deck holds no images yet', async () => {
    const res = await createDeck('Foreign back', { back_file_id: foreignFileId });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/upload the back into it/);
  });

  describe('cards', () => {
    let deckId: string;

    beforeAll(async () => {
      deckId = (await createDeck('Card list')).body.id;
      // Into the deck, which is the only place a card can come from: an image
      // in Assets is not one until it is moved in.
      [cardA, cardB] = await Promise.all([
        uploadTo(owner, projectId, 'card-a.png', { deck_id: deckId }),
        uploadTo(owner, projectId, 'card-b.png', { deck_id: deckId }),
      ]);
      await uploadTo(owner, projectId, 'back.png', { deck_id: deckId, role: 'back' });
    });

    it('replaces the whole list, numbering positions from the array', async () => {
      const res = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: cardA, quantity: 3 },
          { file_id: cardB, quantity: 1 },
        ],
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.cards.map((card: { position: number }) => card.position)).toEqual([0, 1]);
      expect(body.cards[0].file_id).toBe(cardA);
      expect(body.cards[0].quantity).toBe(3);
      // The whole file row rides along, so the editor draws a thumbnail and
      // warns about resolution without a second request.
      expect(body.cards[0].file.filename).toBe('card-a.png');
      expect(body.deck.card_count).toBe(2);
      expect(body.deck.total_copies).toBe(4);
    });

    it('reorders by rewriting the list rather than moving one row', async () => {
      await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: cardB, quantity: 1 },
          { file_id: cardA, quantity: 3 },
        ],
      });
      const body = await (await owner.api.get(`/api/decks/${deckId}`)).json();
      expect(body.cards.map((card: { file_id: string }) => card.file_id)).toEqual([cardB, cardA]);
    });

    it('refuses a list that leaves one of the deck’s own images out', async () => {
      const res = await owner.api.put(`/api/decks/${deckId}/cards`, { cards: [] });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/no place in it/);
    });

    it('refuses an image from Assets that has not been moved in', async () => {
      const res = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: cardA, quantity: 1 },
          { file_id: cardB, quantity: 1 },
          { file_id: assetId, quantity: 1 },
        ],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/an image this deck holds/);
    });

    it('refuses the same card twice, because that is a quantity', async () => {
      const res = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: cardA, quantity: 1 },
          { file_id: cardA, quantity: 1 },
        ],
      });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/only appear in a deck once/);
    });

    it('refuses a card from another project', async () => {
      const res = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [{ file_id: foreignFileId, quantity: 1 }],
      });
      expect(res.status).toBe(422);
    });

    it('takes the back out of the deck when it is moved to Assets', async () => {
      const deck = (await createDeck('Loses a back by hand')).body.id as string;
      const back = await uploadTo(owner, projectId, 'hand-back.png', {
        deck_id: deck,
        role: 'back',
      });
      expect((await (await owner.api.get(`/api/decks/${deck}`)).json()).deck.back_file_id).toBe(
        back
      );

      expect((await owner.api.post(`/api/files/${back}/move`, { folder_id: null })).status).toBe(
        200
      );
      const after = await (await owner.api.get(`/api/decks/${deck}`)).json();
      expect(after.deck.back_file_id).toBeNull();
    });

    it('keeps a card the deck prints none of, counting it once and printing it zero times', async () => {
      const res = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: cardA, quantity: 0 },
          { file_id: cardB, quantity: 2 },
        ],
      });
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.cards[0].quantity).toBe(0);
      // Still a card of this deck, and still in its order: only the pieces of
      // card behind it went away.
      expect(body.deck.card_count).toBe(2);
      expect(body.deck.total_copies).toBe(2);
    });

    it.each([-1, 1000, 1.5])('refuses a quantity of %s', async (quantity) => {
      const res = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: cardA, quantity },
          { file_id: cardB, quantity: 1 },
        ],
      });
      expect(res.status).toBe(422);
    });

    it('refuses a list longer than the cap', async () => {
      const res = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: Array.from({ length: MAX_DECK_CARDS + 1 }, () => ({
          file_id: cardA,
          quantity: 1,
        })),
      });
      expect(res.status).toBe(422);
    });

    it('moves the deck timestamp when only its contents change', async () => {
      const before = (await (await owner.api.get(`/api/decks/${deckId}`)).json()).deck.updated_at;
      await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: cardA, quantity: 2 },
          { file_id: cardB, quantity: 1 },
        ],
      });
      const after = (await (await owner.api.get(`/api/decks/${deckId}`)).json()).deck.updated_at;
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  describe('a card whose image goes away', () => {
    let deckId: string;
    let doomed: string;

    beforeAll(async () => {
      deckId = (await createDeck('Fragile')).body.id;
      // Uploading it into the deck is what makes it a card: there is no second
      // step, because artwork in a deck with no place in it cannot exist.
      doomed = await uploadTo(owner, projectId, 'doomed.png', { deck_id: deckId });
    });

    // A tombstone is what someone deciding whether to restore it reads first,
    // and a deck that silently dropped the card would not show it at all.
    it('keeps a deleted image in the deck, marked as deleted', async () => {
      await owner.api.delete(`/api/files/${doomed}`);
      const body = await (await owner.api.get(`/api/decks/${deckId}`)).json();
      expect(body.cards).toHaveLength(1);
      expect(body.cards[0].file.deleted_at).not.toBeNull();
    });

    it('drops it once the bytes are purged', async () => {
      await owner.api.delete(`/api/files/${doomed}?purge=true`);
      const body = await (await owner.api.get(`/api/decks/${deckId}`)).json();
      expect(body.cards).toEqual([]);
    });
  });

  // The row stays for the restore, and the totals are about what prints. The
  // listing is read as well as the deck, because it is the decks screen that
  // draws these numbers and it reads them from there.
  describe('the totals of a deck holding a deleted card', () => {
    it('leaves the card out while it is deleted, and counts it again once restored', async () => {
      const deckId = (await createDeck('Counts the live ones')).body.id as string;
      const [kept, gone] = await Promise.all([
        uploadTo(owner, projectId, 'counted.png', { deck_id: deckId }),
        uploadTo(owner, projectId, 'uncounted.png', { deck_id: deckId }),
      ]);
      await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: kept, quantity: 2 },
          { file_id: gone, quantity: 3 },
        ],
      });

      const listed = async () =>
        (
          (await (await owner.api.get(`/api/decks?project_id=${projectId}`)).json()).decks as {
            id: string;
            card_count: number;
            total_copies: number;
          }[]
        ).find((deck) => deck.id === deckId)!;

      await owner.api.delete(`/api/files/${gone}`);
      const deleted = await (await owner.api.get(`/api/decks/${deckId}`)).json();
      expect(deleted.cards).toHaveLength(2);
      expect(deleted.deck).toMatchObject({ card_count: 1, total_copies: 2 });
      expect(await listed()).toMatchObject({ card_count: 1, total_copies: 2 });

      expect((await owner.api.post(`/api/files/${gone}/restore`)).status).toBe(200);
      expect(await listed()).toMatchObject({ card_count: 2, total_copies: 5 });
    });
  });

  // What may be named and what must be named are two different sets, and this
  // is where they come apart.
  describe('editing a deck that holds a deleted card', () => {
    let deckId: string;
    let doomed: string;
    let survivor: string;

    beforeAll(async () => {
      deckId = (await createDeck('Holds a tombstone')).body.id;
      [doomed, survivor] = await Promise.all([
        uploadTo(owner, projectId, 'tombstoned.png', { deck_id: deckId }),
        uploadTo(owner, projectId, 'still-here.png', { deck_id: deckId }),
      ]);
      await owner.api.delete(`/api/files/${doomed}`);
    });

    // The list the deck answers with is the list the editor sends back, so a
    // copy count carries every tombstone in it. Refusing them left a deck
    // holding one deleted card unable to change any card's copies at all.
    it('takes the list the deck answers with, tombstone and all', async () => {
      const res = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: doomed, quantity: 1 },
          { file_id: survivor, quantity: 4 },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cards.map((card: { file_id: string }) => card.file_id)).toEqual([
        doomed,
        survivor,
      ]);
      expect(body.cards[1].quantity).toBe(4);
    });

    // The other side of it: an import takes a card out of the arrangement as it
    // tombstones the artwork, so a list that cannot name the row it deleted has
    // to be allowed to leave it out -- and the deck stays editable afterwards.
    it('lets a list leave the tombstone out, and saves again after', async () => {
      const dropped = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [{ file_id: survivor, quantity: 2 }],
      });
      expect(dropped.status).toBe(200);
      expect((await dropped.json()).cards).toHaveLength(1);

      const again = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [{ file_id: survivor, quantity: 3 }],
      });
      expect(again.status).toBe(200);
    });

    // And once its place is gone, restoring the image is what gives it one --
    // a live image the deck owns that no list names is a deck no edit can save.
    it('gives a restored card a new place at the end', async () => {
      // The state an import removal leaves, made here rather than inherited
      // from the test above: a guard runs one case on its own, and a fixture
      // built by its neighbours is one that measures nothing when it does.
      const dropped = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [{ file_id: survivor, quantity: 3 }],
      });
      expect(dropped.status).toBe(200);

      expect((await owner.api.post(`/api/files/${doomed}/restore`)).status).toBe(200);

      const body = await (await owner.api.get(`/api/decks/${deckId}`)).json();
      expect(body.cards.map((card: { file_id: string }) => card.file_id)).toEqual([
        survivor,
        doomed,
      ]);
      expect(body.cards[1].quantity).toBe(1);

      const saved = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: survivor, quantity: 3 },
          { file_id: doomed, quantity: 1 },
        ],
      });
      expect(saved.status).toBe(200);
    });
  });

  // A card deleted by hand keeps its row, so a restore is exact rather than a
  // second arrival at the end of the list.
  describe('restoring a card that kept its place', () => {
    it('leaves its position and its copy count alone', async () => {
      const deckId = (await createDeck('Keeps its order')).body.id as string;
      const [first, second] = await Promise.all([
        uploadTo(owner, projectId, 'order-first.png', { deck_id: deckId }),
        uploadTo(owner, projectId, 'order-second.png', { deck_id: deckId }),
      ]);
      await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: first, quantity: 5 },
          { file_id: second, quantity: 1 },
        ],
      });

      await owner.api.delete(`/api/files/${first}`);
      expect((await owner.api.post(`/api/files/${first}/restore`)).status).toBe(200);

      const body = await (await owner.api.get(`/api/decks/${deckId}`)).json();
      expect(body.cards.map((card: { file_id: string }) => card.file_id)).toEqual([first, second]);
      expect(body.cards[0].quantity).toBe(5);
    });
  });

  // A back is a pointer, not a card. Restoring one must not put it in the list
  // as well, or it would print as a front too.
  describe('restoring a back image', () => {
    it('leaves it out of the card list', async () => {
      const deckId = (await createDeck('Back comes back')).body.id as string;
      const card = await uploadTo(owner, projectId, 'front.png', { deck_id: deckId });
      const back = await uploadTo(owner, projectId, 'the-back.png', {
        deck_id: deckId,
        role: 'back',
      });

      await owner.api.delete(`/api/files/${back}`);
      expect((await owner.api.post(`/api/files/${back}/restore`)).status).toBe(200);

      const body = await (await owner.api.get(`/api/decks/${deckId}`)).json();
      expect(body.cards.map((entry: { file_id: string }) => entry.file_id)).toEqual([card]);
      expect(body.deck.back_file_id).toBe(back);
    });
  });

  describe('a back image that is purged', () => {
    it('leaves the deck standing with no back', async () => {
      const deckId = (await createDeck('Loses its back')).body.id as string;
      const orphanBack = await uploadTo(owner, projectId, 'orphan-back.png', {
        deck_id: deckId,
        role: 'back',
      });

      await owner.api.delete(`/api/files/${orphanBack}?purge=true`);

      const res = await owner.api.get(`/api/decks/${deckId}`);
      expect(res.status).toBe(200);
      expect((await res.json()).deck.back_file_id).toBeNull();
    });
  });

  describe('deleting a deck', () => {
    it('tombstones it and keeps its artwork, and a restore brings both back', async () => {
      const deckId = (await createDeck('Temporary')).body.id as string;
      const card = await uploadTo(owner, projectId, 'temporary-card.png', { deck_id: deckId });

      expect((await owner.api.delete(`/api/decks/${deckId}`)).status).toBe(204);

      // Readable, like a deleted file: its cards are what somebody deciding
      // whether to restore it reads first.
      const gone = await (await owner.api.get(`/api/decks/${deckId}`)).json();
      expect(gone.deck.deleted_at).not.toBeNull();
      expect(gone.cards).toHaveLength(1);
      // The card's own tombstone is untouched. Marking it would make the
      // restore below resurrect artwork somebody had deleted card by card.
      expect(gone.cards[0].file.deleted_at).toBeNull();
      expect((await owner.api.get(`/api/files/${card}`)).status).toBe(200);

      // Out of the listing, though, and out of Assets: a deck's tombstone is
      // never copied onto its artwork, and the artwork was never in Assets.
      const listed = await (await owner.api.get(`/api/decks?project_id=${projectId}`)).json();
      expect(listed.decks.map((deck: { id: string }) => deck.id)).not.toContain(deckId);

      expect((await owner.api.post(`/api/decks/${deckId}/restore`)).status).toBe(200);
      const back = await (await owner.api.get(`/api/decks/${deckId}`)).json();
      expect(back.deck.deleted_at).toBeNull();
      expect(back.cards).toHaveLength(1);
    });

    it('purges the deck and every byte its cards held', async () => {
      const deckId = (await createDeck('Doomed for good')).body.id as string;
      const card = await uploadTo(owner, projectId, 'doomed-for-good.png', { deck_id: deckId });

      expect((await owner.api.delete(`/api/decks/${deckId}?purge=true`)).status).toBe(204);
      expect((await owner.api.get(`/api/decks/${deckId}`)).status).toBe(404);
      expect((await owner.api.get(`/api/files/${card}`)).status).toBe(404);
    });
  });

  describe('authorization', () => {
    let deckId: string;

    beforeAll(async () => {
      deckId = (await createDeck('Guarded')).body.id;
    });

    it('lets a viewer read a deck', async () => {
      expect((await viewer.api.get(`/api/decks/${deckId}`)).status).toBe(200);
    });

    it.each([
      ['renaming', (user: TestUser) => user.api.patch(`/api/decks/${deckId}`, { name: 'Nope' })],
      ['deleting', (user: TestUser) => user.api.delete(`/api/decks/${deckId}`)],
      [
        'editing the cards',
        (user: TestUser) => user.api.put(`/api/decks/${deckId}/cards`, { cards: [] }),
      ],
    ])('refuses a viewer %s with 403', async (_name, act) => {
      expect((await act(viewer)).status).toBe(403);
    });

    it('refuses a viewer creating a deck with 403', async () => {
      const res = await viewer.api.post('/api/decks', {
        project_id: projectId,
        name: 'Viewer deck',
        card_width_mm: poker.width_mm,
        card_height_mm: poker.height_mm,
      });
      expect(res.status).toBe(403);
    });

    // 403 would tell an outsider the deck exists.
    it('sees 404, not 403, for someone with no access at all', async () => {
      expect((await stranger.api.get(`/api/decks/${deckId}`)).status).toBe(404);
      expect((await stranger.api.delete(`/api/decks/${deckId}`)).status).toBe(404);
    });

    it('hides another project’s decks from its listing', async () => {
      expect((await stranger.api.get(`/api/decks?project_id=${projectId}`)).status).toBe(404);
    });
  });
});
