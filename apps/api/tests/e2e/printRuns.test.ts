import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cardPreset } from '@three-peaks/shared';
import { type TestUser, createUser, deleteUser } from '../setup/testContext.ts';

// A PNG header and a byte that makes each one different, so appending a version
// is an actual change of bytes rather than something appendFileVersion dedupes.
function png(seed: number): Buffer {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52,
    seed,
  ]);
}

const poker = cardPreset('poker')!;

interface OutstandingCard {
  file_id: string;
  version_number: number;
  quantity: number;
  back_file_id: string | null;
  back_version_number: number | null;
  printed_copies: number;
  owed_copies: number;
  printed_version_number: number | null;
  last_printed_at: string | null;
  reason: string | null;
}

interface OutstandingDeck {
  deck_id: string;
  back_file_id: string | null;
  back_version_number: number | null;
  last_printed_at: string | null;
  cards: OutstandingCard[];
}

describe('print runs', () => {
  let owner: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let projectId: string;

  async function uploadInto(deckId: string, filename: string, seed: number): Promise<string> {
    const query = new URLSearchParams({ project_id: projectId, filename, deck_id: deckId });
    const res = await owner.api.postBytes(
      `/api/files/upload?${query}`,
      png(seed) as unknown as BodyInit,
      'image/png'
    );
    return (await res.json()).id as string;
  }

  async function newVersion(fileId: string, seed: number): Promise<number> {
    const res = await owner.api.postBytes(
      `/api/files/${fileId}/versions`,
      png(seed) as unknown as BodyInit,
      'image/png'
    );
    return (await res.json()).version.version_number as number;
  }

  async function makeDeck(name: string): Promise<string> {
    const res = await owner.api.post('/api/decks', {
      project_id: projectId,
      name,
      card_width_mm: poker.width_mm,
      card_height_mm: poker.height_mm,
    });
    return (await res.json()).id as string;
  }

  async function setCards(deckId: string, cards: { file_id: string; quantity: number }[]) {
    return owner.api.put(`/api/decks/${deckId}/cards`, { cards });
  }

  async function outstanding(deckId: string, user: TestUser = owner): Promise<OutstandingDeck> {
    const body = await (
      await user.api.get(`/api/print/outstanding?project_id=${projectId}`)
    ).json();
    return body.decks.find((deck: OutstandingDeck) => deck.deck_id === deckId);
  }

  async function cardState(deckId: string, fileId: string): Promise<OutstandingCard> {
    const deck = await outstanding(deckId);
    return deck.cards.find((card) => card.file_id === fileId)!;
  }

  async function record(cards: unknown[], user: TestUser = owner) {
    const res = await user.api.post('/api/print/runs', { project_id: projectId, cards });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    [owner, viewer, stranger] = await Promise.all([
      createUser('print-owner'),
      createUser('print-viewer'),
      createUser('print-stranger'),
    ]);
    projectId = (await (await owner.api.post('/api/projects', { name: 'Print project' })).json())
      .id;
    await owner.api.put(`/api/projects/${projectId}/members`, {
      email: viewer.email,
      role: 'viewer',
    });
  });

  afterAll(async () => {
    for (const user of [owner, viewer, stranger]) await deleteUser(user);
  });

  it('owes every copy of a card nothing has printed', async () => {
    const deckId = await makeDeck('Never printed');
    const fileId = await uploadInto(deckId, 'alpha.png', 1);
    await setCards(deckId, [{ file_id: fileId, quantity: 3 }]);

    const deck = await outstanding(deckId);
    expect(deck.last_printed_at).toBeNull();
    expect(deck.cards).toEqual([
      {
        file_id: fileId,
        version_number: 1,
        quantity: 3,
        back_file_id: null,
        back_version_number: null,
        printed_copies: 0,
        owed_copies: 3,
        printed_version_number: null,
        last_printed_at: null,
        reason: 'never',
      },
    ]);
  });

  it('owes nothing once the run is recorded, and says when', async () => {
    const deckId = await makeDeck('Recorded');
    const fileId = await uploadInto(deckId, 'beta.png', 2);
    await setCards(deckId, [{ file_id: fileId, quantity: 2 }]);

    const recorded = await record([{ file_id: fileId, version_number: 1, copies: 2 }]);
    expect(recorded.status).toBe(201);
    expect(recorded.body).toMatchObject({ card_count: 1, copies: 2, created_by: owner.id });

    const deck = await outstanding(deckId);
    expect(deck.last_printed_at).toBe(recorded.body.created_at);
    expect(deck.cards[0]).toMatchObject({
      printed_copies: 2,
      owed_copies: 0,
      printed_version_number: 1,
      reason: null,
    });
  });

  it('owes the difference when a copy count goes up, and accumulates part runs', async () => {
    const deckId = await makeDeck('More copies');
    const fileId = await uploadInto(deckId, 'gamma.png', 3);
    await setCards(deckId, [{ file_id: fileId, quantity: 2 }]);
    await record([{ file_id: fileId, version_number: 1, copies: 2 }]);

    await setCards(deckId, [{ file_id: fileId, quantity: 5 }]);
    expect(await cardState(deckId, fileId)).toMatchObject({
      printed_copies: 2,
      owed_copies: 3,
      reason: 'copies',
    });

    // The shortfall printed on its own has to leave nothing owed, or every
    // partial run would ask for the same three cards for ever.
    await record([{ file_id: fileId, version_number: 1, copies: 3 }]);
    expect(await cardState(deckId, fileId)).toMatchObject({
      printed_copies: 5,
      owed_copies: 0,
      reason: null,
    });
  });

  it('owes the whole card again when its artwork is versioned', async () => {
    const deckId = await makeDeck('New artwork');
    const fileId = await uploadInto(deckId, 'delta.png', 4);
    await setCards(deckId, [{ file_id: fileId, quantity: 4 }]);
    await record([{ file_id: fileId, version_number: 1, copies: 4 }]);

    expect(await newVersion(fileId, 40)).toBe(2);
    expect(await cardState(deckId, fileId)).toMatchObject({
      version_number: 2,
      printed_copies: 0,
      owed_copies: 4,
      printed_version_number: 1,
      reason: 'artwork',
    });
  });

  it('leaves a card alone when a re-import writes no new version', async () => {
    const deckId = await makeDeck('Unchanged artwork');
    const fileId = await uploadInto(deckId, 'epsilon.png', 5);
    await setCards(deckId, [{ file_id: fileId, quantity: 1 }]);
    await record([{ file_id: fileId, version_number: 1, copies: 1 }]);

    // The same bytes again, which is what an unchanged Canva page arrives as.
    expect(await newVersion(fileId, 5)).toBe(1);
    expect(await cardState(deckId, fileId)).toMatchObject({ owed_copies: 0, reason: null });
  });

  it('owes every card again when the deck is given a new back', async () => {
    const deckId = await makeDeck('New back');
    const fileId = await uploadInto(deckId, 'zeta.png', 6);
    const backId = await uploadInto(deckId, 'back.png', 60);
    await setCards(deckId, [
      { file_id: fileId, quantity: 2 },
      { file_id: backId, quantity: 0 },
    ]);
    await owner.api.patch(`/api/decks/${deckId}`, { back_file_id: backId });

    await record([
      {
        file_id: fileId,
        version_number: 1,
        copies: 2,
        back_file_id: backId,
        back_version_number: 1,
      },
    ]);
    expect(await cardState(deckId, fileId)).toMatchObject({ owed_copies: 0, reason: null });

    expect(await newVersion(backId, 61)).toBe(2);
    expect(await cardState(deckId, fileId)).toMatchObject({
      owed_copies: 2,
      printed_version_number: 1,
      reason: 'back',
    });

    // The back itself is held at no copies, so nothing is owed of it as a card.
    expect(await cardState(deckId, backId)).toMatchObject({ owed_copies: 0, reason: null });
  });

  it('does not ask for a card again because the backing pages were left out', async () => {
    const deckId = await makeDeck('Fronts only');
    const fileId = await uploadInto(deckId, 'eta.png', 7);
    const backId = await uploadInto(deckId, 'eta-back.png', 70);
    await setCards(deckId, [
      { file_id: fileId, quantity: 1 },
      { file_id: backId, quantity: 0 },
    ]);
    await owner.api.patch(`/api/decks/${deckId}`, { back_file_id: backId });

    // No back recorded: the run put no reverse on these cards, so nothing a
    // later change of back does can make one wrong. Somebody printing fronts
    // onto pre-backed stock would otherwise be owed every card for ever.
    await record([{ file_id: fileId, version_number: 1, copies: 1 }]);
    expect(await cardState(deckId, fileId)).toMatchObject({ owed_copies: 0, reason: null });

    expect(await newVersion(backId, 71)).toBe(2);
    expect(await cardState(deckId, fileId)).toMatchObject({ owed_copies: 0, reason: null });
  });

  it('owes nothing for a card the deck holds no copies of', async () => {
    const deckId = await makeDeck('Zero copies');
    const fileId = await uploadInto(deckId, 'theta.png', 8);
    await setCards(deckId, [{ file_id: fileId, quantity: 0 }]);
    expect(await cardState(deckId, fileId)).toMatchObject({ owed_copies: 0, reason: null });
  });

  it('leaves a deleted card out entirely', async () => {
    const deckId = await makeDeck('Deleted card');
    const fileId = await uploadInto(deckId, 'iota.png', 9);
    const keptId = await uploadInto(deckId, 'kappa.png', 10);
    await setCards(deckId, [
      { file_id: fileId, quantity: 1 },
      { file_id: keptId, quantity: 1 },
    ]);
    await owner.api.delete(`/api/files/${fileId}`);

    const deck = await outstanding(deckId);
    expect(deck.cards.map((card) => card.file_id)).toEqual([keptId]);
  });

  it('gives the cards back what they owed when a run is undone', async () => {
    const deckId = await makeDeck('Undone');
    const fileId = await uploadInto(deckId, 'lambda.png', 11);
    await setCards(deckId, [{ file_id: fileId, quantity: 2 }]);

    const recorded = await record([{ file_id: fileId, version_number: 1, copies: 2 }]);
    expect(await cardState(deckId, fileId)).toMatchObject({ owed_copies: 0 });

    const undone = await owner.api.delete(`/api/print/runs/${recorded.body.id}`);
    expect(undone.status).toBe(204);
    expect(await cardState(deckId, fileId)).toMatchObject({
      owed_copies: 2,
      printed_version_number: null,
      last_printed_at: null,
      reason: 'never',
    });
  });

  it('refuses a version the file does not have', async () => {
    const deckId = await makeDeck('Invented version');
    const fileId = await uploadInto(deckId, 'mu.png', 12);
    await setCards(deckId, [{ file_id: fileId, quantity: 1 }]);
    expect((await record([{ file_id: fileId, version_number: 2, copies: 1 }])).status).toBe(422);
  });

  it('refuses the same card twice in one run', async () => {
    const deckId = await makeDeck('Twice');
    const fileId = await uploadInto(deckId, 'nu.png', 13);
    await setCards(deckId, [{ file_id: fileId, quantity: 2 }]);
    const res = await record([
      { file_id: fileId, version_number: 1, copies: 1 },
      { file_id: fileId, version_number: 1, copies: 1 },
    ]);
    expect(res.status).toBe(422);
  });

  it('refuses a file that is not a card of a deck in this project', async () => {
    const elsewhere = (
      await (await stranger.api.post('/api/projects', { name: 'Elsewhere' })).json()
    ).id;
    const query = new URLSearchParams({ project_id: elsewhere, filename: 'foreign.png' });
    const foreign = (
      await (
        await stranger.api.postBytes(
          `/api/files/upload?${query}`,
          png(14) as unknown as BodyInit,
          'image/png'
        )
      ).json()
    ).id as string;

    expect((await record([{ file_id: foreign, version_number: 1, copies: 1 }])).status).toBe(422);
  });

  it('refuses a viewer recording or undoing a run, and a stranger reading one', async () => {
    const deckId = await makeDeck('Permissions');
    const fileId = await uploadInto(deckId, 'xi.png', 15);
    await setCards(deckId, [{ file_id: fileId, quantity: 1 }]);

    expect((await record([{ file_id: fileId, version_number: 1, copies: 1 }], viewer)).status).toBe(
      403
    );

    const mine = await record([{ file_id: fileId, version_number: 1, copies: 1 }]);
    expect((await viewer.api.delete(`/api/print/runs/${mine.body.id}`)).status).toBe(403);
    expect((await viewer.api.get(`/api/print/outstanding?project_id=${projectId}`)).status).toBe(
      200
    );
    expect((await stranger.api.get(`/api/print/outstanding?project_id=${projectId}`)).status).toBe(
      404
    );
    expect((await stranger.api.delete(`/api/print/runs/${mine.body.id}`)).status).toBe(404);
  });
  // A punchboard's tokens owe the printer the way a deck's cards do; the one
  // difference is that each token's reverse is its own.
  describe('a punchboard’s tokens', () => {
    let board: string;
    let challenge: string;
    let challengeBack: string;
    let seeker: string;

    async function upload(filename: string, seed: number, into: Record<string, string>) {
      const query = new URLSearchParams({ project_id: projectId, filename, ...into });
      const res = await owner.api.postBytes(
        `/api/files/upload?${query}`,
        png(seed) as unknown as BodyInit,
        'image/png'
      );
      return (await res.json()).id as string;
    }

    async function tokens(): Promise<OutstandingCard[]> {
      const body = await (
        await owner.api.get(`/api/print/outstanding?project_id=${projectId}`)
      ).json();
      return body.punchboards.find(
        (entry: { component_id: string }) => entry.component_id === board
      ).tokens;
    }

    beforeAll(async () => {
      board = (
        await (
          await owner.api.post('/api/components', {
            project_id: projectId,
            kind: 'punchboard',
            name: 'Tokens',
          })
        ).json()
      ).id;
      challenge = await upload('two.png', 40, { component_id: board });
      challengeBack = await upload('two back.png', 41, {
        component_id: board,
        role: 'back',
        back_of: challenge,
      });
      seeker = await upload('seeker.png', 42, { component_id: board });
      await owner.api.put(`/api/components/${board}/tokens`, {
        tokens: [
          { file_id: challenge, back_file_id: challengeBack, quantity: 1 },
          { file_id: seeker, back_file_id: seeker, quantity: 2 },
        ],
      });
    });

    it('owes every copy of each token, each behind its own back', async () => {
      expect(await tokens()).toMatchObject([
        {
          file_id: challenge,
          quantity: 1,
          owed_copies: 1,
          back_file_id: challengeBack,
          reason: 'never',
        },
        { file_id: seeker, quantity: 2, owed_copies: 2, back_file_id: seeker, reason: 'never' },
      ]);
    });

    it('records tokens as printed, and owes one again when its own back changes', async () => {
      const recorded = await record([
        {
          file_id: challenge,
          version_number: 1,
          copies: 1,
          back_file_id: challengeBack,
          back_version_number: 1,
        },
        {
          file_id: seeker,
          version_number: 1,
          copies: 2,
          back_file_id: seeker,
          back_version_number: 1,
        },
      ]);
      expect(recorded.status).toBe(201);
      expect((await tokens()).map((token) => token.owed_copies)).toEqual([0, 0]);

      expect(await newVersion(challengeBack, 43)).toBe(2);
      const [first, second] = await tokens();
      expect(first).toMatchObject({ owed_copies: 1, back_version_number: 2, reason: 'back' });
      expect(second!.owed_copies).toBe(0);
    });

    it('leaves a back that is deleted off its token', async () => {
      expect((await owner.api.delete(`/api/files/${challengeBack}`)).status).toBe(204);
      expect((await tokens())[0]).toMatchObject({ back_file_id: null, back_version_number: null });
    });
  });
});
