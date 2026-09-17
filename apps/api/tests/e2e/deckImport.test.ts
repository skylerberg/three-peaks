import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { IMPORT_TITLE_MAX_LENGTH, MAX_DECK_CARDS, cardPreset } from '@three-peaks/shared';
import { db } from '../../src/db/index.ts';
import { createUser, deleteUser, type TestUser } from '../setup/testContext.ts';

// A PNG signature and then the artwork, so two pages that look different hash
// differently. Content type is decided by the magic bytes, never by the header.
function png(artwork: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`IHDR ${artwork}`, 'utf8'),
  ]);
}

const poker = cardPreset('poker')!;

interface Page {
  title?: string | null;
  bytes: Buffer;
  // The page's own id in the design. Every manifest carries one, so leaving it
  // out here does not mean "no id" -- it means an id this deck has never seen,
  // which is what a page built somewhere else arrives as.
  pageId?: string;
}

interface PageResult {
  page_number: number;
  outcome: string;
  matched_by: string | null;
  restored: boolean;
  replayed: boolean;
  file_id: string | null;
  file_version_number: number | null;
  name: string;
}

interface RunCounts {
  pages: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  restored: number;
}

interface Run {
  id: string;
  import_id: string;
  status: string;
  source_label: string | null;
  page_count: number;
  started_by: string;
  started_at: string;
  finished_at: string | null;
  counts: RunCounts;
}

interface PlanPage {
  page_number: number;
  title: string | null;
  action: string;
  matched_by: string | null;
  name: string | null;
  is_back: boolean;
}

interface StartedRun extends Run {
  plan: {
    added: number;
    updated: number;
    removed: { file_id: string; name: string }[];
    pages: PlanPage[];
  };
}

interface RunCard {
  page_number: number | null;
  outcome: string;
  matched_by: string | null;
  restored: boolean;
  name: string;
  file_id: string | null;
  file_version_number: number | null;
}

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

interface DeckAsOf {
  run: Run;
  cards: AsOfCard[];
  has_purged_history: boolean;
}

describe('deck imports', () => {
  let owner: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let projectId: string;

  beforeAll(async () => {
    [owner, viewer, stranger] = await Promise.all([
      createUser('import-owner'),
      createUser('import-viewer'),
      createUser('import-stranger'),
    ]);

    projectId = (await (await owner.api.post('/api/projects', { name: 'Canva' })).json()).id;
    await owner.api.put(`/api/projects/${projectId}/members`, {
      email: viewer.email,
      role: 'viewer',
    });
  });

  // import_run.started_by is RESTRICT and every run here was started inside the
  // owner's project, so the project has to go before any of the accounts do.
  afterAll(async () => {
    for (const user of [owner, viewer, stranger]) await deleteUser(user);
  });

  async function makeFolder(name: string, parentId?: string): Promise<string> {
    const res = await owner.api.post('/api/files/folders', {
      project_id: projectId,
      name,
      ...(parentId ? { parent_id: parentId } : {}),
    });
    expect(res.status).toBe(201);
    return (await res.json()).id as string;
  }

  async function makeDeck(name: string): Promise<string> {
    const res = await owner.api.post('/api/decks', {
      project_id: projectId,
      name,
      card_width_mm: poker.width_mm,
      card_height_mm: poker.height_mm,
    });
    expect(res.status).toBe(201);
    return (await res.json()).id as string;
  }

  // Nothing to set up: the deck is where its artwork lands, and the import row
  // that remembers the export appears on the first run.
  async function scenario(name: string) {
    return { deckId: await makeDeck(name) };
  }

  // Two spellings of one request: the page count the run route reads, and the
  // manifest of page numbers, titles and page ids a run that plans its matching
  // up front is computed from. Undeclared keys are stripped by the validator,
  // so whichever half the server does not know about costs nothing to send.
  //
  // A page that names no id gets a fresh one rather than none: the manifest
  // requires one, and an id nothing has seen leaves the weaker tiers to settle
  // the page -- which is what these tests are about whenever they leave it out.
  function startRun(deckId: string, pageCount: number, user: TestUser = owner, pages: Page[] = []) {
    return user.api.post(`/api/decks/${deckId}/import/runs`, {
      page_count: pageCount,
      pages: Array.from({ length: pageCount }, (_, index) => {
        const title = pages[index]?.title;
        return {
          page_number: index + 1,
          ...(title === undefined || title === null ? {} : { title }),
          page_id: pages[index]?.pageId ?? randomUUID(),
        };
      }),
    });
  }

  async function openRun(
    deckId: string,
    pageCount: number,
    pages: Page[] = []
  ): Promise<StartedRun> {
    const res = await startRun(deckId, pageCount, owner, pages);
    expect(res.status).toBe(201);
    return (await res.json()) as StartedRun;
  }

  function postPage(
    runId: string,
    pageNumber: number,
    bytes: Buffer,
    title?: string | null,
    user: TestUser = owner
  ) {
    const query = new URLSearchParams({ page_number: String(pageNumber) });
    if (title !== undefined && title !== null) query.set('title', title);
    return user.api.postBytes(
      `/api/decks/import/runs/${runId}/pages?${query}`,
      bytes as unknown as BodyInit,
      'image/png'
    );
  }

  async function landPage(runId: string, pageNumber: number, page: Page): Promise<PageResult> {
    const res = await postPage(runId, pageNumber, page.bytes, page.title);
    expect([200, 201]).toContain(res.status);
    return (await res.json()) as PageResult;
  }

  function finish(runId: string, user: TestUser = owner) {
    return user.api.post(`/api/decks/import/runs/${runId}/finish`);
  }

  function abandon(runId: string, user: TestUser = owner) {
    return user.api.post(`/api/decks/import/runs/${runId}/abandon`);
  }

  interface Import {
    run: Run;
    pages: Map<number, PageResult>;
    detail: { run: Run; cards: RunCard[] };
  }

  // One whole export: start, post every page, finish. `reverse` posts the last
  // page first, which is the only difference between the two orders a client
  // could walk an export in.
  async function importPages(
    deckId: string,
    pages: Page[],
    opts: { reverse?: boolean } = {}
  ): Promise<Import> {
    const run = await openRun(deckId, pages.length, pages);
    const order = pages.map((_, index) => index + 1);
    if (opts.reverse) order.reverse();

    const results = new Map<number, PageResult>();
    for (const number of order) {
      results.set(number, await landPage(run.id, number, pages[number - 1]));
    }

    const done = await finish(run.id);
    expect(done.status).toBe(200);
    // The run as finishing left it, not as starting it did: the counts on the
    // start response are all zero and would make every count assertion vacuous.
    const detail = (await done.json()) as { run: Run; cards: RunCard[] };
    return { run: detail.run, pages: results, detail };
  }

  async function readDeck(deckId: string) {
    const res = await owner.api.get(`/api/decks/${deckId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as {
      deck: { id: string; back_file_id: string | null };
      cards: {
        file_id: string;
        quantity: number;
        position: number;
        file: { filename: string; name_locked: boolean };
      }[];
    };
  }

  async function readImport(deckId: string, user: TestUser = owner) {
    const res = await user.api.get(`/api/decks/${deckId}/import`);
    return { status: res.status, body: await res.json() };
  }

  async function timeline(deckId: string): Promise<Run[]> {
    const res = await owner.api.get(`/api/decks/${deckId}/import/runs`);
    expect(res.status).toBe(200);
    return (await res.json()).runs as Run[];
  }

  function runDetailRes(deckId: string, runId: string, user: TestUser = owner) {
    return user.api.get(`/api/decks/${deckId}/import/runs/${runId}`);
  }

  async function runDetail(deckId: string, runId: string): Promise<{ run: Run; cards: RunCard[] }> {
    const res = await runDetailRes(deckId, runId);
    expect(res.status).toBe(200);
    return (await res.json()) as { run: Run; cards: RunCard[] };
  }

  function asOfRes(deckId: string, runId: string, user: TestUser = owner) {
    return user.api.get(`/api/decks/${deckId}/import/runs/${runId}/deck`);
  }

  async function asOf(deckId: string, runId: string): Promise<DeckAsOf> {
    const res = await asOfRes(deckId, runId);
    expect(res.status).toBe(200);
    return (await res.json()) as DeckAsOf;
  }

  async function readFile(fileId: string) {
    const res = await owner.api.get(`/api/files/${fileId}`);
    return { status: res.status, body: await res.json() };
  }

  async function versionCount(fileId: string): Promise<number> {
    const res = await owner.api.get(`/api/files/${fileId}/versions`);
    expect(res.status).toBe(200);
    return ((await res.json()).versions as unknown[]).length;
  }

  async function filenamesIn(deckId: string): Promise<string[]> {
    return (await readDeck(deckId)).cards.map((card) => card.file.filename).sort();
  }

  // The same names unsorted, which is the deck's own arrangement: what the
  // explorer draws, what the sheets pack and what the scene lays out.
  async function cardOrderIn(deckId: string): Promise<string[]> {
    return (await readDeck(deckId)).cards.map((card) => card.file.filename);
  }

  async function uploadByHand(deckId: string, filename: string, bytes: Buffer): Promise<string> {
    const query = new URLSearchParams({ project_id: projectId, filename, deck_id: deckId });
    const res = await owner.api.postBytes(
      `/api/files/upload?${query}`,
      bytes as unknown as BodyInit,
      'image/png'
    );
    expect(res.status).toBe(201);
    return (await res.json()).id as string;
  }

  // Every timestamp here is stamped in milliseconds, so two writes inside one
  // of them would make an ordering assertion vacuous rather than false.
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

  const outcomes = (pages: Map<number, PageResult>) =>
    [...pages.entries()].sort(([a], [b]) => a - b).map(([, result]) => result.outcome);

  describe('the import row', () => {
    it('appears on the first run rather than being set up beforehand', async () => {
      const { deckId } = await scenario('implicit-import');
      // 404 here is "never imported", not "pick a folder first": there is
      // nowhere else the artwork could go.
      expect((await readImport(deckId)).status).toBe(404);

      await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);

      const binding = await readImport(deckId);
      expect(binding.status).toBe(200);
      expect(binding.body.deck_id).toBe(deckId);
      expect(binding.body.open_run_id).toBeNull();
    });

    it('keeps the timeline when the deck is tombstoned, and refuses a run into it', async () => {
      const { deckId } = await scenario('deleted-deck-import');
      await importPages(deckId, [{ title: 'Doomed', bytes: png('doomed') }]);

      expect((await owner.api.delete(`/api/decks/${deckId}`)).status).toBe(204);

      expect(await timeline(deckId)).toHaveLength(1);
      expect((await startRun(deckId, 1)).status).toBe(409);

      // And it resumes on the way back, which is what makes the tombstone a
      // pause rather than the end of the deck's history.
      expect((await owner.api.post(`/api/decks/${deckId}/restore`)).status).toBe(200);
      expect((await startRun(deckId, 1)).status).toBe(201);
    });

    // The column is NOT NULL and nothing reads it back, so what it holds is
    // checked here rather than through a response: a value the CHECK refuses
    // would fail the first import of every deck.
    it('writes a source kind the constraint admits', async () => {
      const { deckId } = await scenario('source-kind');
      await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);

      const row = await db
        .selectFrom('deck_import')
        .select(['source_kind'])
        .where('deck_id', '=', deckId)
        .executeTakeFirstOrThrow();
      expect(row.source_kind).toBe('canva');

      await expect(
        db
          .updateTable('deck_import')
          .set({ source_kind: 'figma' })
          .where('deck_id', '=', deckId)
          .execute()
      ).rejects.toThrow(/deck_import_source_kind_known/u);
    });
  });

  describe('a first export', () => {
    let deckId: string;
    let first: Import;

    beforeAll(async () => {
      ({ deckId } = await scenario('first-export'));
      first = await importPages(deckId, [
        { bytes: png('untitled front') },
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Dragon', bytes: png('dragon') },
      ]);
    });

    it('names each card after the page it came from', async () => {
      expect(await filenamesIn(deckId)).toEqual(['1.png', '2 - Goblin.png', '3 - Dragon.png']);
      expect(outcomes(first.pages)).toEqual(['added', 'added', 'added']);
      expect(first.pages.get(2)!.matched_by).toBeNull();
      expect(first.pages.get(2)!.file_version_number).toBe(1);
    });

    it('adds every card it created to the deck, in page order', async () => {
      const deck = await readDeck(deckId);
      expect(deck.cards.map((card) => card.position)).toEqual([0, 1, 2]);
      expect(deck.cards.map((card) => card.file_id)).toEqual([
        first.pages.get(1)!.file_id,
        first.pages.get(2)!.file_id,
        first.pages.get(3)!.file_id,
      ]);
      expect(deck.cards.every((card) => card.quantity === 1)).toBe(true);
    });

    it('reports the same counts on the run as its own rows do', async () => {
      const run = (await timeline(deckId))[0];
      expect(run.counts).toEqual({
        pages: 3,
        added: 3,
        updated: 0,
        unchanged: 0,
        removed: 0,
        restored: 0,
      });
      const cached = await db
        .selectFrom('import_run')
        .select(['import_run.summary as summary'])
        .where('import_run.id', '=', run.id)
        .executeTakeFirstOrThrow();
      expect(cached.summary).toEqual(run.counts);
    });
  });

  describe('re-importing', () => {
    it('writes no versions when nothing changed, and says so', async () => {
      const { deckId } = await scenario('unchanged-reimport');
      const pages = [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ];
      const first = await importPages(deckId, pages);
      const second = await importPages(deckId, pages);

      expect(outcomes(second.pages)).toEqual(['unchanged', 'unchanged']);
      expect(second.run.counts).toMatchObject({ unchanged: 2, added: 0, updated: 0, removed: 0 });
      for (const number of [1, 2]) {
        const fileId = first.pages.get(number)!.file_id!;
        expect(second.pages.get(number)!.file_id).toBe(fileId);
        expect(await versionCount(fileId)).toBe(1);
      }
    });

    it('versions only the card whose artwork changed', async () => {
      const { deckId } = await scenario('one-card-changed');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const second = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta redrawn') },
      ]);

      expect(outcomes(second.pages)).toEqual(['unchanged', 'updated']);
      expect(second.pages.get(2)!.file_version_number).toBe(2);
      expect(await versionCount(first.pages.get(1)!.file_id!)).toBe(1);
      expect(await versionCount(first.pages.get(2)!.file_id!)).toBe(2);
    });

    it('matches a reordered export by title rather than by page number', async () => {
      const { deckId } = await scenario('reordered-titles');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);
      const second = await importPages(deckId, [
        { title: 'Gamma', bytes: png('gamma') },
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);

      expect([...second.pages.values()].every((page) => page.matched_by === 'identity')).toBe(true);
      expect(second.pages.get(1)!.file_id).toBe(first.pages.get(3)!.file_id);
      expect(second.pages.get(2)!.file_id).toBe(first.pages.get(1)!.file_id);
      expect(second.pages.get(3)!.file_id).toBe(first.pages.get(2)!.file_id);
      expect(second.run.counts.removed).toBe(0);
      expect(second.run.counts.added).toBe(0);
    });

    it('gives the same deck whichever order the pages are posted in', async () => {
      const original = [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
        { title: 'Gamma', bytes: png('gamma') },
      ];
      const reordered = [
        { title: 'Gamma', bytes: png('gamma redrawn') },
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ];

      const forwards = await scenario('order-forwards');
      const backwards = await scenario('order-backwards');
      const firstForwards = await importPages(forwards.deckId, original);
      const firstBackwards = await importPages(backwards.deckId, original);

      const secondForwards = await importPages(forwards.deckId, reordered);
      const secondBackwards = await importPages(backwards.deckId, reordered, { reverse: true });

      // The same shape told two ways: which page of the first export each page
      // of the second landed on, what the card ended up called, and how it was
      // matched. Nothing in it may depend on the order the pages arrived in.
      const shape = (before: Import, after: Import) =>
        [1, 2, 3].map((number) => ({
          page: number,
          from: [...before.pages].find(
            ([, page]) => page.file_id === after.pages.get(number)!.file_id
          )![0],
          name: after.pages.get(number)!.name,
          outcome: after.pages.get(number)!.outcome,
          matched_by: after.pages.get(number)!.matched_by,
          version: after.pages.get(number)!.file_version_number,
        }));

      expect(shape(firstBackwards, secondBackwards)).toEqual(shape(firstForwards, secondForwards));
      expect(secondBackwards.run.counts).toEqual(secondForwards.run.counts);
      expect(await filenamesIn(backwards.deckId)).toEqual(await filenamesIn(forwards.deckId));
    });

    it('falls back to the page number when a title changed, and re-anchors on it', async () => {
      const { deckId } = await scenario('retitled-card');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const second = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta the Bold', bytes: png('beta') },
      ]);

      expect(second.pages.get(2)!.matched_by).toBe('page_number');
      expect(second.pages.get(2)!.file_id).toBe(first.pages.get(2)!.file_id);
      expect(second.pages.get(2)!.name).toBe('2 - Beta the Bold.png');
      expect(second.run.counts.removed).toBe(0);

      // Finish wrote the new key onto the mapping row, so the export that keeps
      // the new title matches by identity from here on rather than by position.
      const third = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta the Bold', bytes: png('beta') },
      ]);
      expect(third.pages.get(2)!.matched_by).toBe('identity');
      expect(third.pages.get(2)!.file_id).toBe(first.pages.get(2)!.file_id);
    });
  });

  describe('two pages with one title', () => {
    it('imports both rather than refusing the deck', async () => {
      const { deckId } = await scenario('duplicate-titles');
      const pages = [
        { title: 'Back', bytes: png('back one') },
        { title: 'Back', bytes: png('back two') },
      ];
      const first = await importPages(deckId, pages);

      expect(outcomes(first.pages)).toEqual(['added', 'added']);
      expect(first.pages.get(1)!.file_id).not.toBe(first.pages.get(2)!.file_id);
      expect(await filenamesIn(deckId)).toEqual(['1 - Back.png', '2 - Back.png']);
      expect((await readDeck(deckId)).cards).toHaveLength(2);

      // And the next import finds both again: the loser of the collision took a
      // key of its own at finish rather than being left to collide forever.
      const second = await importPages(deckId, pages);
      expect(second.pages.get(1)!.file_id).toBe(first.pages.get(1)!.file_id);
      expect(second.pages.get(2)!.file_id).toBe(first.pages.get(2)!.file_id);
      expect(second.run.counts.added).toBe(0);
      expect(second.run.counts.removed).toBe(0);
    });

    it('keeps a page titled "2" apart from the untitled page 2', async () => {
      const { deckId } = await scenario('titled-two');
      const pages = [
        { title: '2', bytes: png('a page called two') },
        { bytes: png('the second page') },
      ];
      const first = await importPages(deckId, pages);
      const second = await importPages(deckId, pages);

      // Both keys would read "2" without the prefix that says which kind they
      // are, and the untitled card would then be reachable only by its number.
      expect(second.pages.get(1)!.matched_by).toBe('identity');
      expect(second.pages.get(2)!.matched_by).toBe('identity');
      expect(second.pages.get(1)!.file_id).toBe(first.pages.get(1)!.file_id);
      expect(second.pages.get(2)!.file_id).toBe(first.pages.get(2)!.file_id);
      expect(second.run.counts.removed).toBe(0);
    });
  });

  describe('posting a page twice', () => {
    it('answers with what happened the first time', async () => {
      const { deckId } = await scenario('replayed-page');
      const run = await openRun(deckId, 2);

      const first = await landPage(run.id, 1, { title: 'Alpha', bytes: png('alpha') });
      expect(first.replayed).toBe(false);
      expect(first.outcome).toBe('added');

      // Different artwork under the same page number: the ledger row is the
      // answer, so nothing is worked out again and no version is written.
      const res = await postPage(run.id, 1, png('alpha redrawn'), 'Alpha');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ...first, replayed: true });

      await landPage(run.id, 2, { title: 'Beta', bytes: png('beta') });
      expect((await finish(run.id)).status).toBe(200);

      expect(await versionCount(first.file_id!)).toBe(1);
      const detail = await runDetail(deckId, run.id);
      expect(detail.cards.filter((card) => card.page_number === 1)).toHaveLength(1);
    });
  });

  describe('a page that stops being exported', () => {
    it('tombstones only the card no page matched, and takes it out of the deck', async () => {
      const { deckId } = await scenario('dropped-page');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);

      const second = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      expect(second.run.counts.removed).toBe(1);

      const gone = first.pages.get(3)!.file_id!;
      expect((await readFile(gone)).body.deleted_at).not.toBeNull();
      expect((await readFile(first.pages.get(1)!.file_id!)).body.deleted_at).toBeNull();

      const removed = second.detail.cards.find((card) => card.outcome === 'removed')!;
      expect(removed.name).toBe('3 - Gamma.png');
      expect(removed.page_number).toBeNull();

      const deck = await readDeck(deckId);
      expect(deck.cards.map((card) => card.file_id)).toEqual([
        first.pages.get(1)!.file_id,
        first.pages.get(2)!.file_id,
      ]);
    });

    it('names the card it is about to remove, before a single page is uploaded', async () => {
      const { deckId } = await scenario('named-removal');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);

      // Delta first, so the two titles that survive move down a page and the
      // page-number fallback has nothing left to give Delta.
      const run = await openRun(deckId, 3, [
        { title: 'Delta', bytes: png('delta') },
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);

      expect(run.plan.removed).toEqual([
        { file_id: first.pages.get(3)!.file_id, name: '3 - Gamma.png' },
      ]);
      // A page that lands on a card says which one; a new page has none to say.
      expect(run.plan.pages.map((page) => page.name)).toEqual([
        null,
        '1 - Alpha.png',
        '2 - Beta.png',
      ]);
      expect((await abandon(run.id)).status).toBe(200);
      // Nothing was tombstoned by reading the plan.
      expect((await readFile(first.pages.get(3)!.file_id!)).body.deleted_at).toBeNull();
    });

    it('restores the card when it comes back instead of adding a second one', async () => {
      const { deckId } = await scenario('returning-card');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);
      await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);

      const back = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);

      const returned = back.pages.get(2)!;
      expect(returned.file_id).toBe(first.pages.get(2)!.file_id);
      expect(returned.restored).toBe(true);
      expect(returned.outcome).toBe('added');
      // Found by its key, not by the page number happening to line up again:
      // the identity probe is what has to keep reaching a tombstone.
      expect(returned.matched_by).toBe('identity');
      expect(back.run.counts.restored).toBe(1);
      expect(await versionCount(returned.file_id!)).toBe(1);
      expect((await readFile(returned.file_id!)).body.deleted_at).toBeNull();
      expect((await readDeck(deckId)).cards.map((card) => card.file_id)).toContain(
        returned.file_id
      );
    });

    it('restores it under a suffix when its name has been taken meanwhile', async () => {
      const { deckId } = await scenario('returning-under-suffix');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);
      await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);
      await uploadByHand(deckId, '2 - Gamma.png', png('by hand'));

      const back = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);
      const returned = back.pages.get(2)!;
      expect(returned.file_id).toBe(first.pages.get(2)!.file_id);
      expect(returned.name).toBe('2 - Gamma (2).png');
      expect((await readFile(returned.file_id!)).body.name_locked).toBe(false);
    });

    it('leaves a file somebody put in the folder by hand alone', async () => {
      const { deckId } = await scenario('hand-placed-file');
      await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);
      const byHand = await uploadByHand(deckId, 'notes.png', png('notes'));

      await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);
      expect((await readFile(byHand)).body.deleted_at).toBeNull();
    });
  });

  describe('a name a person typed', () => {
    it('survives an import that still versions the artwork', async () => {
      const { deckId } = await scenario('locked-name');
      const first = await importPages(deckId, [{ title: 'Goblin', bytes: png('goblin') }]);
      const fileId = first.pages.get(1)!.file_id!;

      const renamed = await owner.api.patch(`/api/files/${fileId}`, { filename: 'Chosen.png' });
      expect(renamed.status).toBe(200);
      expect((await renamed.json()).name_locked).toBe(true);

      const second = await importPages(deckId, [{ title: 'Goblin', bytes: png('goblin v2') }]);
      expect(second.pages.get(1)!.name).toBe('Chosen.png');
      expect(second.pages.get(1)!.outcome).toBe('updated');
      expect(second.pages.get(1)!.file_version_number).toBe(2);
      expect((await readFile(fileId)).body.filename).toBe('Chosen.png');
    });

    it('gives the name back to the export once the lock is cleared', async () => {
      const { deckId } = await scenario('unlocked-name');
      const first = await importPages(deckId, [{ title: 'Goblin', bytes: png('goblin') }]);
      const fileId = first.pages.get(1)!.file_id!;

      await owner.api.patch(`/api/files/${fileId}`, { filename: 'Chosen.png' });
      const cleared = await owner.api.patch(`/api/files/${fileId}`, { name_locked: false });
      expect(cleared.status).toBe(200);
      expect((await cleared.json()).name_locked).toBe(false);

      await importPages(deckId, [{ title: 'Goblin', bytes: png('goblin') }]);
      expect((await readFile(fileId)).body.filename).toBe('1 - Goblin.png');
    });
  });

  describe('a deck somebody has arranged by hand', () => {
    it('keeps a hand-set copy count, and takes the design\u2019s order back', async () => {
      const { deckId } = await scenario('hand-arranged');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);
      const [alpha, beta, gamma] = [1, 2, 3].map((number) => first.pages.get(number)!.file_id!);

      const arranged = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: gamma, quantity: 5 },
          { file_id: alpha, quantity: 2 },
          { file_id: beta, quantity: 1 },
        ],
      });
      expect(arranged.status).toBe(200);

      await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
        { title: 'Gamma', bytes: png('gamma redrawn') },
      ]);

      // The design is where the order comes from, so a hand-set one is undone
      // by the next import. How many of each to print is not the design's to
      // say, and survives it.
      const deck = await readDeck(deckId);
      expect(deck.cards.map((card) => card.file_id)).toEqual([alpha, beta, gamma]);
      expect(deck.cards.map((card) => card.quantity)).toEqual([2, 1, 5]);
      expect(deck.cards.map((card) => card.position)).toEqual([0, 1, 2]);
    });

    it('refuses a card list that would leave one of its own images out', async () => {
      const { deckId } = await scenario('hand-removed');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const [alpha, beta] = [1, 2].map((number) => first.pages.get(number)!.file_id!);

      // The deck owns Beta, so dropping it from the list would leave artwork in
      // the deck with no place in it -- and no screen showing it anywhere.
      const trimmed = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [{ file_id: alpha, quantity: 1 }],
      });
      expect(trimmed.status).toBe(422);

      // Moving it out is how it leaves, and then the list is accepted.
      const elsewhere = await makeFolder('hand-removed-destination');
      expect(
        (await owner.api.post(`/api/files/${beta}/move`, { folder_id: elsewhere })).status
      ).toBe(200);
      expect(
        (
          await owner.api.put(`/api/decks/${deckId}/cards`, {
            cards: [{ file_id: alpha, quantity: 1 }],
          })
        ).status
      ).toBe(200);

      // The image is untouched by the move: it is in Assets, versioned as it
      // was, and no import tombstoned it on the way out.
      expect(await versionCount(beta)).toBe(1);
      expect((await readFile(beta)).body.deleted_at).toBeNull();
      expect((await readFile(beta)).body.deck_id).toBeNull();
    });
  });

  describe('the order a deck ends up in', () => {
    it('follows the design when its pages are moved around', async () => {
      const { deckId } = await scenario('canva-order-moved');
      await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);
      expect(await cardOrderIn(deckId)).toEqual(['1 - Alpha.png', '2 - Beta.png', '3 - Gamma.png']);

      // Every page matches the card it matched before -- by title, since the
      // numbers have all moved -- so nothing is added or removed and the whole
      // of what changed is where each one sits.
      const second = await importPages(deckId, [
        { title: 'Gamma', bytes: png('gamma') },
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      expect(second.run.counts.added).toBe(0);
      expect(second.run.counts.removed).toBe(0);
      expect(await cardOrderIn(deckId)).toEqual(['1 - Gamma.png', '2 - Alpha.png', '3 - Beta.png']);
    });

    it('trails a card somebody put in the deck themselves', async () => {
      const { deckId } = await scenario('canva-order-hand-added');
      await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const byHand = await uploadByHand(deckId, 'Token.png', png('token'));

      // In front of both pages, so trailing it afterwards is a move rather than
      // where an upload happened to land it.
      const deck = await readDeck(deckId);
      const arranged = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: byHand, quantity: 4 },
          ...deck.cards
            .filter((card) => card.file_id !== byHand)
            .map((card) => ({ file_id: card.file_id, quantity: card.quantity })),
        ],
      });
      expect(arranged.status).toBe(200);

      await importPages(deckId, [
        { title: 'Beta', bytes: png('beta') },
        { title: 'Alpha', bytes: png('alpha') },
      ]);

      // The design's pages in the design's order, and then the card the design
      // knows nothing about, still holding its own copy count.
      expect(await cardOrderIn(deckId)).toEqual(['1 - Beta.png', '2 - Alpha.png', 'Token.png']);
      const after = await readDeck(deckId);
      expect(after.cards[2].file_id).toBe(byHand);
      expect(after.cards[2].quantity).toBe(4);
    });

    it('trails a card the design has stopped naming and somebody had deleted', async () => {
      const { deckId } = await scenario('canva-order-deleted-card');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);
      const beta = first.pages.get(2)!.file_id!;
      expect((await owner.api.delete(`/api/files/${beta}`)).status).toBe(204);

      // A card tombstoned before the run started is not one the run removed, so
      // its row stays in the deck and a restore is still exact. The design has
      // no page for it, so it has no place among them either.
      const second = await importPages(deckId, [
        { title: 'Gamma', bytes: png('gamma') },
        { title: 'Alpha', bytes: png('alpha') },
      ]);
      expect(second.run.counts.removed).toBe(0);
      expect(await cardOrderIn(deckId)).toEqual(['1 - Gamma.png', '2 - Alpha.png', '2 - Beta.png']);
    });

    it('puts the back where the design puts it', async () => {
      const { deckId } = await scenario('canva-order-back-moved');
      const first = await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Back', bytes: png('the back') },
        { title: 'Dragon', bytes: png('dragon') },
      ]);
      const back = first.pages.get(2)!.file_id!;

      await importPages(deckId, [
        { title: 'Back', bytes: png('the back') },
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Dragon', bytes: png('dragon') },
      ]);

      // A back is a card of the deck held at no copies, so it takes a place in
      // the arrangement like any other page of the design.
      const deck = await readDeck(deckId);
      expect(deck.deck.back_file_id).toBe(back);
      expect(deck.cards.map((card) => card.file_id)[0]).toBe(back);
      expect(deck.cards.map((card) => card.quantity)).toEqual([0, 1, 1]);
    });

    it('is the same whichever order the pages were posted in', async () => {
      const pages = [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
        { title: 'Gamma', bytes: png('gamma') },
      ];
      const forwards = await scenario('canva-order-posted-forwards');
      const backwards = await scenario('canva-order-posted-backwards');

      await importPages(forwards.deckId, pages);
      await importPages(backwards.deckId, pages, { reverse: true });

      // The arrangement is the design's, and a page of it is no more or less
      // itself for having been uploaded last.
      expect(await cardOrderIn(backwards.deckId)).toEqual(await cardOrderIn(forwards.deckId));
      expect(await cardOrderIn(forwards.deckId)).toEqual([
        '1 - Alpha.png',
        '2 - Beta.png',
        '3 - Gamma.png',
      ]);
    });
  });

  describe('a page titled Back', () => {
    it('becomes the deck\u2019s back, held at no copies, and leaves the rest alone', async () => {
      const { deckId } = await scenario('an-export-with-a-back');
      const run = await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Back', bytes: png('the back') },
        { title: 'Dragon', bytes: png('dragon') },
      ]);
      const back = run.pages.get(2)!.file_id!;

      const deck = await readDeck(deckId);
      expect(deck.deck.back_file_id).toBe(back);
      expect(deck.cards.find((card) => card.file_id === back)!.quantity).toBe(0);
      // Still a row, still in page order: the deck editor draws it, and the
      // back picker offers only images the card list names.
      expect(deck.cards.map((card) => card.file_id)).toEqual([
        run.pages.get(1)!.file_id,
        back,
        run.pages.get(3)!.file_id,
      ]);
      expect(
        deck.cards.filter((card) => card.file_id !== back).map((card) => card.quantity)
      ).toEqual([1, 1]);
    });

    it('reads the title the way an identity key does', async () => {
      const { deckId } = await scenario('a-back-spelled-loudly');
      const run = await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: '  BACK ', bytes: png('the back') },
      ]);
      expect((await readDeck(deckId)).deck.back_file_id).toBe(run.pages.get(2)!.file_id);
    });

    it('leaves a card that merely mentions a back as a card', async () => {
      const { deckId } = await scenario('a-back-of-beyond');
      await importPages(deckId, [
        { title: 'Back of beyond', bytes: png('beyond') },
        { title: 'Player backs', bytes: png('players') },
      ]);
      const deck = await readDeck(deckId);
      expect(deck.deck.back_file_id).toBeNull();
      expect(deck.cards.map((card) => card.quantity)).toEqual([1, 1]);
    });

    it('says so on the plan, before a page goes up', async () => {
      const { deckId } = await scenario('a-back-on-the-plan');
      const run = await openRun(deckId, 2, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Back', bytes: png('the back') },
      ]);
      expect(run.plan.pages.map((page) => page.is_back)).toEqual([false, true]);
      expect((await abandon(run.id)).status).toBe(200);
    });

    it('takes an existing card to no copies, so a deck imported before this catches up', async () => {
      const { deckId } = await scenario('a-back-that-was-a-card');
      const first = await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Back', bytes: png('the back') },
      ]);
      const back = first.pages.get(2)!.file_id!;

      // The deck a release before this one would have left: the back is an
      // ordinary card at a copy, and nothing points at it.
      const arranged = await owner.api.put(`/api/decks/${deckId}/cards`, {
        cards: [
          { file_id: first.pages.get(1)!.file_id!, quantity: 1 },
          { file_id: back, quantity: 1 },
        ],
      });
      expect(arranged.status).toBe(200);
      expect((await owner.api.patch(`/api/decks/${deckId}`, { back_file_id: null })).status).toBe(
        200
      );

      await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Back', bytes: png('the back') },
      ]);

      const deck = await readDeck(deckId);
      expect(deck.deck.back_file_id).toBe(back);
      expect(deck.cards.find((card) => card.file_id === back)!.quantity).toBe(0);
    });

    it('keeps the back and its zero across a re-import that changes nothing else', async () => {
      const { deckId } = await scenario('a-back-imported-twice');
      const first = await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Back', bytes: png('the back') },
      ]);
      const back = first.pages.get(2)!.file_id!;

      const second = await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Back', bytes: png('the back') },
      ]);
      expect(second.pages.get(2)!.outcome).toBe('unchanged');

      const deck = await readDeck(deckId);
      expect(deck.deck.back_file_id).toBe(back);
      expect(deck.cards.find((card) => card.file_id === back)!.quantity).toBe(0);
      expect(deck.cards).toHaveLength(2);
    });

    it('hands a back with no card row back to the deck at no copies', async () => {
      const { deckId } = await scenario('a-back-taken-off-the-list');
      const first = await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Hero', bytes: png('hero') },
      ]);
      const [goblin, hero] = [1, 2].map((number) => first.pages.get(number)!.file_id!);

      // A back may be left off the card list -- it is the one image a deck can
      // hold with no place in the arrangement -- so this is a back with no row
      // of its own, reached without a page ever being titled Back.
      expect((await owner.api.patch(`/api/decks/${deckId}`, { back_file_id: hero })).status).toBe(
        200
      );
      expect(
        (
          await owner.api.put(`/api/decks/${deckId}/cards`, {
            cards: [{ file_id: goblin, quantity: 1 }],
          })
        ).status
      ).toBe(200);
      expect((await readDeck(deckId)).cards).toHaveLength(1);

      await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Hero', bytes: png('hero') },
      ]);

      // A copy here would print this deck's back on the front of a sheet.
      const deck = await readDeck(deckId);
      expect(deck.deck.back_file_id).toBe(hero);
      expect(deck.cards.find((card) => card.file_id === hero)!.quantity).toBe(0);
      expect(deck.cards.find((card) => card.file_id === goblin)!.quantity).toBe(1);
    });

    it('leaves a back alone once the export has stopped calling a page Back', async () => {
      const { deckId } = await scenario('a-back-renamed');
      const first = await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Back', bytes: png('the back') },
      ]);
      const back = first.pages.get(2)!.file_id!;

      // The page keeps its card -- it is matched by page number -- and the
      // import asserts what the export says rather than undoing what it once
      // did. A back somebody chose by hand is indistinguishable from this one,
      // and clearing it would be the same statement about both.
      await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Hero', bytes: png('the back') },
      ]);

      const deck = await readDeck(deckId);
      expect(deck.deck.back_file_id).toBe(back);
      expect(deck.cards.find((card) => card.file_id === back)!.quantity).toBe(0);
    });

    it('takes the back out of the deck when the export stops having one', async () => {
      const { deckId } = await scenario('a-back-dropped');
      const first = await importPages(deckId, [
        { title: 'Goblin', bytes: png('goblin') },
        { title: 'Back', bytes: png('the back') },
      ]);
      const back = first.pages.get(2)!.file_id!;

      await importPages(deckId, [{ title: 'Goblin', bytes: png('goblin') }]);

      // Tombstoned like any card the export stopped having, and the pointer is
      // left where it is: restoring the image is what puts the back back, the
      // way restoring any tombstone is symmetric with deleting it.
      expect((await readFile(back)).body.deleted_at).not.toBeNull();
      const deck = await readDeck(deckId);
      expect(deck.deck.back_file_id).toBe(back);
      expect(deck.cards.map((card) => card.file_id)).toEqual([first.pages.get(1)!.file_id]);
    });
  });

  describe('a run that does not finish', () => {
    it('refuses to finish before every page it declared has landed', async () => {
      const { deckId } = await scenario('half-a-run');
      const run = await openRun(deckId, 3);
      await landPage(run.id, 1, { title: 'Alpha', bytes: png('alpha') });

      const res = await finish(run.id);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/imported 1 of 3 pages/);
      expect((await readImport(deckId)).body.open_run_id).toBe(run.id);
      // The page that landed is already a card: the deck owns the artwork the
      // moment it arrives, and artwork in a deck with no place in it is the one
      // state this arrangement has none of.
      expect((await readDeck(deckId)).cards).toHaveLength(1);
      expect((await abandon(run.id)).status).toBe(200);
    });

    it('refuses a page past the count the run declared', async () => {
      const { deckId } = await scenario('past-the-count');
      const run = await openRun(deckId, 2);
      expect((await postPage(run.id, 3, png('overflow'), 'Extra')).status).toBe(409);
      expect((await abandon(run.id)).status).toBe(200);
    });

    it('refuses a second run and names the open one', async () => {
      const { deckId } = await scenario('one-run-at-a-time');
      const run = await openRun(deckId, 1);

      const res = await startRun(deckId, 1);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.run_id).toBe(run.id);
      expect(typeof body.started_at).toBe('string');
      expect((await abandon(run.id)).status).toBe(200);
    });

    it('abandons half way and leaves every page that landed imported', async () => {
      const { deckId } = await scenario('abandoned-run');
      const run = await openRun(deckId, 4);
      await landPage(run.id, 1, { title: 'Alpha', bytes: png('alpha') });
      await landPage(run.id, 2, { title: 'Beta', bytes: png('beta') });

      const res = await abandon(run.id);
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe('abandoned');
      expect(await filenamesIn(deckId)).toEqual(['1 - Alpha.png', '2 - Beta.png']);
      // An abandon tombstones nothing, and the two pages that landed stay in
      // the deck -- they are its artwork now, and leaving them out of its
      // arrangement would put them on no screen at all.
      expect((await readDeck(deckId)).cards).toHaveLength(2);
    });

    it('re-runs after an abandon with no duplicates and no wasted versions', async () => {
      const { deckId } = await scenario('rerun-after-abandon');
      const pages = [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
        { title: 'Gamma', bytes: png('gamma') },
      ];

      const abandoned = await openRun(deckId, 3);
      const landed = [
        await landPage(abandoned.id, 1, pages[0]),
        await landPage(abandoned.id, 2, pages[1]),
      ];
      expect((await abandon(abandoned.id)).status).toBe(200);

      const complete = await importPages(deckId, pages);
      expect(outcomes(complete.pages)).toEqual(['unchanged', 'unchanged', 'added']);
      expect(complete.pages.get(1)!.file_id).toBe(landed[0].file_id);
      expect(complete.pages.get(2)!.file_id).toBe(landed[1].file_id);
      expect(complete.run.counts.removed).toBe(0);
      expect(await filenamesIn(deckId)).toEqual(['1 - Alpha.png', '2 - Beta.png', '3 - Gamma.png']);

      // The two that landed under the abandoned run had never been handed to
      // the deck, so this finish is what puts all three of them in it.
      const deck = await readDeck(deckId);
      expect(deck.cards.map((card) => card.file_id)).toEqual([
        landed[0].file_id,
        landed[1].file_id,
        complete.pages.get(3)!.file_id,
      ]);
      for (const card of deck.cards) expect(await versionCount(card.file_id)).toBe(1);
    });
  });

  describe('a card that leaves the folder', () => {
    it('stops being imported without being tombstoned, and stays in its past runs', async () => {
      const { deckId } = await scenario('moved-out');
      const elsewhere = await makeFolder('moved-out-destination');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const moved = first.pages.get(2)!.file_id!;

      expect(
        (await owner.api.post(`/api/files/${moved}/move`, { folder_id: elsewhere })).status
      ).toBe(200);

      const second = await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);
      expect(second.run.counts.removed).toBe(0);
      expect((await readFile(moved)).body.deleted_at).toBeNull();
      expect((await readFile(moved)).body.folder_id).toBe(elsewhere);

      const past = await runDetail(deckId, first.run.id);
      expect(past.cards.find((card) => card.page_number === 2)!.file_id).toBe(moved);
    });

    it('keeps a past run readable after its image is purged', async () => {
      const { deckId } = await scenario('purged-card');
      const first = await importPages(deckId, [{ title: 'One', bytes: png('one') }]);
      const fileId = first.pages.get(1)!.file_id!;

      expect((await owner.api.delete(`/api/files/${fileId}`)).status).toBe(204);
      expect((await owner.api.delete(`/api/files/${fileId}?purge=true`)).status).toBe(204);

      const past = await runDetail(deckId, first.run.id);
      expect(past.cards).toHaveLength(1);
      expect(past.cards[0].file_id).toBeNull();
      expect(past.cards[0].name).toBe('1 - One.png');
      expect(past.cards[0].page_number).toBe(1);
    });
  });

  describe('bytes that are not an image', () => {
    it('refuses the page and keeps nothing', async () => {
      const { deckId } = await scenario('not-an-image');
      const run = await openRun(deckId, 1);

      const res = await postPage(run.id, 1, Buffer.from('this is a spreadsheet'), 'Alpha');
      expect(res.status).toBe(422);
      expect(await filenamesIn(deckId)).toEqual([]);
      expect((await abandon(run.id)).status).toBe(200);
    });
  });

  describe('two pages contending for one card', () => {
    // Alpha and Beta are already imported. The next export renames nothing and
    // shifts everything up a page: page 1 is Beta, page 2 is a card called
    // Gamma that the deck has never seen. Beta's card is claimed by its title,
    // Gamma finds no free card at page 2 once that has happened, and Alpha's
    // card is what the export stopped having. Which page the client uploaded
    // first is not one of the facts that decides any of it.
    const original: Page[] = [
      { title: 'Alpha', bytes: png('alpha') },
      { title: 'Beta', bytes: png('beta') },
    ];
    const shifted: Page[] = [
      { title: 'Beta', bytes: png('beta') },
      { title: 'Gamma', bytes: png('gamma') },
    ];

    it.each([
      ['in page order', false],
      ['backwards', true],
    ])(
      'resolves a contended card the same way with the pages posted %s',
      async (label, reverse) => {
        const { deckId } = await scenario(`contended-${label.replace(/ /gu, '-')}`);
        const first = await importPages(deckId, original);
        const second = await importPages(deckId, shifted, { reverse });

        expect(second.pages.get(1)!.matched_by).toBe('identity');
        expect(second.pages.get(1)!.file_id).toBe(first.pages.get(2)!.file_id);
        expect(second.pages.get(2)!.matched_by).toBeNull();
        expect(second.pages.get(2)!.outcome).toBe('added');
        expect(second.run.counts).toEqual({
          pages: 2,
          added: 1,
          updated: 1,
          unchanged: 0,
          removed: 1,
          restored: 0,
        });

        expect((await readFile(first.pages.get(1)!.file_id!)).body.deleted_at).not.toBeNull();
        expect((await readDeck(deckId)).cards.map((card) => card.file_id)).toEqual([
          first.pages.get(2)!.file_id,
          second.pages.get(2)!.file_id,
        ]);
      }
    );
  });

  describe('a page inserted in the middle of an export', () => {
    it('is itself the new card, and leaves the pages it shifted on their own', async () => {
      const { deckId } = await scenario('inserted-page');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);

      // Gamma is slid in between them, so Beta arrives a page later than the
      // card that answers to its title. Gamma is the page with nothing to
      // answer to, and it is the one that becomes a card.
      const pages: Page[] = [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Gamma', bytes: png('gamma') },
        { title: 'Beta', bytes: png('beta') },
      ];
      const run = await openRun(deckId, pages.length, pages);
      await landPage(run.id, 1, pages[0]);

      const inserted = await postPage(run.id, 2, pages[1].bytes, pages[1].title);
      expect({ status: inserted.status, body: await inserted.json() }).toMatchObject({
        status: 201,
        body: { outcome: 'added', matched_by: null },
      });

      const shifted = await landPage(run.id, 3, pages[2]);
      expect(shifted.matched_by).toBe('identity');
      expect(shifted.file_id).toBe(first.pages.get(2)!.file_id);
      expect(shifted.name).toBe('3 - Beta.png');

      expect((await finish(run.id)).status).toBe(200);
      expect((await runDetail(deckId, run.id)).run.counts.removed).toBe(0);
      expect((await readFile(first.pages.get(1)!.file_id!)).body.deleted_at).toBeNull();
      expect((await readFile(first.pages.get(2)!.file_id!)).body.deleted_at).toBeNull();
      expect((await readDeck(deckId)).cards).toHaveLength(3);
    });
  });

  describe('a title naming a card an earlier page would have taken by number', () => {
    it('gives that card to the page that names it, not to the page walked first', async () => {
      const { deckId } = await scenario('identity-beats-position');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);

      // Page 1 has lost its title and page 2 has picked up the one page 1 used
      // to carry. Matched in one interleaved walk, page 1's page-number probe
      // takes Alpha's card before page 2 ever asks for it by name — a weaker
      // claim beating an exact one on nothing but being walked first.
      const second = await importPages(deckId, [
        { bytes: png('an untitled cover') },
        { title: 'Alpha', bytes: png('alpha') },
      ]);

      expect(second.pages.get(2)!.matched_by).toBe('identity');
      expect(second.pages.get(2)!.file_id).toBe(first.pages.get(1)!.file_id);
      expect(second.pages.get(1)!.matched_by).toBeNull();
      expect(second.pages.get(1)!.outcome).toBe('added');
      expect(second.pages.get(1)!.file_id).not.toBe(first.pages.get(1)!.file_id);

      // Beta is what this export stopped having, and Alpha's artwork was never
      // versioned over with the untitled page's.
      expect((await readFile(first.pages.get(2)!.file_id!)).body.deleted_at).not.toBeNull();
      expect(await versionCount(first.pages.get(1)!.file_id!)).toBe(1);
      expect(second.run.counts).toEqual({
        pages: 2,
        added: 1,
        updated: 1,
        unchanged: 0,
        removed: 1,
        restored: 0,
      });
    });
  });

  describe('a page title the manifest and the upload have to agree on', () => {
    const limit = 'x'.repeat(IMPORT_TITLE_MAX_LENGTH);

    // The manifest truncated at the bound where posting the page rejects, so an
    // over-long title was planned and then refused by the page carrying it —
    // and a run that can never reach its page count can never finish, which
    // left abandoning it the only way out.
    it.each([
      ['one character past the limit', `${limit}x`, false],
      ['a control character', 'Back\u0007Two', false],
      ['nothing but spaces', '   ', false],
      ['exactly the limit', limit, true],
    ])('takes or refuses %s in both', async (label, title, allowed) => {
      const { deckId } = await scenario(`title-${label.replace(/ /gu, '-')}`);

      const manifest = await owner.api.post(`/api/decks/${deckId}/import/runs`, {
        pages: [{ page_number: 1, title, page_id: randomUUID() }],
      });
      expect(manifest.status).toBe(allowed ? 201 : 422);

      let run: Run;
      if (allowed) {
        run = (await manifest.json()) as Run;
      } else {
        // Nothing was opened, so there is no wedged run to abandon.
        expect(await timeline(deckId)).toEqual([]);
        run = await openRun(deckId, 1, [{ title: 'Fits', bytes: png('fits') }]);
      }

      // 400 rather than 422 because this half of the pair is a query parameter,
      // which is the one thing about the two that does not match.
      const page = await postPage(run.id, 1, png('page'), title);
      expect(page.status).toBe(allowed ? 201 : 400);
      expect((await abandon(run.id)).status).toBe(200);
    });
  });

  describe('a card whose file was moved out between runs', () => {
    it('imports its page again rather than on the key the moved row still holds', async () => {
      const { deckId } = await scenario('moved-out-then-re-exported');
      const elsewhere = await makeFolder('moved-out-then-re-exported-destination');
      const pages: Page[] = [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ];
      const first = await importPages(deckId, pages);
      const moved = first.pages.get(2)!.file_id!;
      expect(
        (await owner.api.post(`/api/files/${moved}/move`, { folder_id: elsewhere })).status
      ).toBe(200);

      // Nothing has finished since the move, so the mapping row for the moved
      // file is still attached and still holding Beta's key.
      const run = await openRun(deckId, pages.length, pages);
      await landPage(run.id, 1, pages[0]);
      const again = await postPage(run.id, 2, pages[1].bytes, pages[1].title);
      expect({ status: again.status, body: await again.json() }).toMatchObject({
        status: 201,
        body: { outcome: 'added', matched_by: null },
      });

      expect((await finish(run.id)).status).toBe(200);
      expect((await readFile(moved)).body.deleted_at).toBeNull();
      expect((await readFile(moved)).body.folder_id).toBe(elsewhere);
      // Two, not three: moving the file out took it out of the arrangement as
      // well, so what is left is Alpha and the card page 2 was imported onto.
      expect((await readDeck(deckId)).cards).toHaveLength(2);
    });
  });

  describe('a deck at its card cap', () => {
    let filler = 0;

    // Cards without an upload each: the cap is five hundred of them and what
    // this is measuring is the number, not the bytes.
    async function fillDeck(deckId: string, count: number): Promise<void> {
      const rows = Array.from({ length: count }, () => {
        filler += 1;
        return { id: randomUUID(), filename: `filler-${filler}.png`, position: filler };
      });

      await db
        .insertInto('file')
        .values(
          rows.map((row) => ({
            id: row.id,
            project_id: projectId,
            deck_id: deckId,
            filename: row.filename,
            storage_key: randomUUID(),
            content_type: 'image/png',
            byte_size: '0',
            uploaded_by: owner.id,
          }))
        )
        .execute();

      await db
        .insertInto('deck_card')
        .values(
          rows.map((row) => ({
            id: randomUUID(),
            deck_id: deckId,
            file_id: row.id,
            quantity: 1,
            position: row.position,
          }))
        )
        .execute();
    }

    it('refuses the run before a single page is uploaded', async () => {
      const { deckId } = await scenario('deck-at-the-cap');
      await fillDeck(deckId, MAX_DECK_CARDS);

      const page: Page = { title: 'One too many', bytes: png('spill') };
      const res = await startRun(deckId, 1, owner, [page]);
      expect({ status: res.status, body: await res.json() }).toMatchObject({ status: 422 });

      // Nothing was opened at all: the import row is written inside the same
      // transaction the refusal rolls back.
      expect((await readImport(deckId)).status).toBe(404);
      expect((await readDeck(deckId)).cards).toHaveLength(MAX_DECK_CARDS);
    });

    it('refuses the page a hand edit has pushed past the cap', async () => {
      const { deckId } = await scenario('deck-filled-during-a-run');
      await fillDeck(deckId, MAX_DECK_CARDS - 1);

      const page: Page = { title: 'One too many', bytes: png('spill') };
      const run = await openRun(deckId, 1, [page]);
      // The last free place, taken by hand while the run was open.
      await fillDeck(deckId, 1);

      // The page rather than the finish: the card joins the deck as its bytes
      // land, so that is where the cap has to hold. A deck one card past it is
      // one the editor can never save again.
      const res = await postPage(run.id, 1, page.bytes, page.title);
      expect({ status: res.status, body: await res.json() }).toMatchObject({ status: 422 });
      expect((await readDeck(deckId)).cards).toHaveLength(MAX_DECK_CARDS);
      expect((await abandon(run.id)).status).toBe(200);
    });
  });

  describe("the file embedded in a deck's cards", () => {
    it('says whether a person has named it', async () => {
      const { deckId } = await scenario('deck-card-file-fields');
      const first = await importPages(deckId, [{ title: 'Goblin', bytes: png('goblin') }]);
      const fileId = first.pages.get(1)!.file_id!;

      expect((await readDeck(deckId)).cards[0].file.name_locked).toBe(false);
      expect(
        (await owner.api.patch(`/api/files/${fileId}`, { filename: 'Chosen.png' })).status
      ).toBe(200);
      expect((await readDeck(deckId)).cards[0].file.name_locked).toBe(true);
    });
  });

  describe('what one run did', () => {
    // The deck in the path is the scope, not decoration: without it a run of
    // another deck reads perfectly well under this deck's name.
    it('refuses a run that belongs to another deck', async () => {
      const mine = await scenario('run-detail-this-deck');
      const theirs = await scenario('run-detail-another-deck');
      await importPages(mine.deckId, [{ title: 'Alpha', bytes: png('alpha') }]);
      const other = await importPages(theirs.deckId, [{ title: 'Beta', bytes: png('beta') }]);

      expect((await runDetailRes(theirs.deckId, other.run.id)).status).toBe(200);
      const res = await runDetailRes(mine.deckId, other.run.id);
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 404,
        body: { error: 'Import run not found' },
      });
    });

    it('is readable by a viewer and 404 for a stranger', async () => {
      const { deckId } = await scenario('run-detail-guarded');
      const first = await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);

      expect((await runDetailRes(deckId, first.run.id, viewer)).status).toBe(200);
      expect((await runDetailRes(deckId, first.run.id, stranger)).status).toBe(404);
    });
  });

  describe('a source that names its own pages', () => {
    // Opaque, and deliberately not sorted, spelled or lengthed like anything
    // this repo generates: a page id is another system's string and nothing
    // here parses one.
    const P1 = 'MAGtjPqGmnQ';
    const P2 = 'MAFxKk2p0lE';
    const P3 = 'MAEwYt7RbcU';

    const matches = (pages: Map<number, PageResult>) =>
      [...pages.entries()].sort(([a], [b]) => a - b).map(([, result]) => result.matched_by);

    it('carries an id onto the card a title matched, and matches on it after', async () => {
      const { deckId } = await scenario('canva-adoption');

      // Ids this deck has never seen: the cards were made by an export whose
      // pages carried other ones.
      const built = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);

      // So the titles are what place them, and nothing is tombstoned -- which
      // is the whole point of the fallback.
      const adopting = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha'), pageId: P1 },
        { title: 'Beta', bytes: png('beta'), pageId: P2 },
      ]);
      expect(matches(adopting.pages)).toEqual(['identity', 'identity']);
      expect(adopting.run.counts).toMatchObject({ added: 0, removed: 0, unchanged: 2 });
      expect(adopting.pages.get(1)!.file_id).toBe(built.pages.get(1)!.file_id);

      // Finishing wrote those ids onto the cards they matched, so the next run
      // reaches them by the strongest tier there is.
      const settled = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha'), pageId: P1 },
        { title: 'Beta', bytes: png('beta'), pageId: P2 },
      ]);
      expect(matches(settled.pages)).toEqual(['page_id', 'page_id']);
      expect(settled.run.counts).toMatchObject({ added: 0, removed: 0 });
      expect(settled.pages.get(1)!.file_id).toBe(built.pages.get(1)!.file_id);
    });

    it('keeps every card through a rename and a reorder at once', async () => {
      const { deckId } = await scenario('canva-rename-reorder');

      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha'), pageId: P1 },
        { title: 'Beta', bytes: png('beta'), pageId: P2 },
        { title: 'Gamma', bytes: png('gamma'), pageId: P3 },
      ]);
      // Adopted on the run after the one that created them, exactly as above.
      await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha'), pageId: P1 },
        { title: 'Beta', bytes: png('beta'), pageId: P2 },
        { title: 'Gamma', bytes: png('gamma'), pageId: P3 },
      ]);

      // Every title is new and every page has moved. Nothing but the id could
      // place these: matching by title finds nothing, and matching by number
      // would put each card's artwork on its neighbour.
      const shuffled = await importPages(deckId, [
        { title: 'Third', bytes: png('gamma'), pageId: P3 },
        { title: 'First', bytes: png('alpha'), pageId: P1 },
        { title: 'Second', bytes: png('beta'), pageId: P2 },
      ]);

      expect(matches(shuffled.pages)).toEqual(['page_id', 'page_id', 'page_id']);
      expect(shuffled.run.counts).toMatchObject({ added: 0, removed: 0 });
      expect(shuffled.pages.get(1)!.file_id).toBe(first.pages.get(3)!.file_id);
      expect(shuffled.pages.get(2)!.file_id).toBe(first.pages.get(1)!.file_id);
      expect(shuffled.pages.get(3)!.file_id).toBe(first.pages.get(2)!.file_id);
    });

    it('places untitled pages through a reorder, which their numbers could not', async () => {
      const { deckId } = await scenario('canva-untitled-reorder');

      const first = await importPages(deckId, [
        { bytes: png('one'), pageId: P1 },
        { bytes: png('two'), pageId: P2 },
      ]);
      await importPages(deckId, [
        { bytes: png('one'), pageId: P1 },
        { bytes: png('two'), pageId: P2 },
      ]);

      const swapped = await importPages(deckId, [
        { bytes: png('two'), pageId: P2 },
        { bytes: png('one'), pageId: P1 },
      ]);

      expect(matches(swapped.pages)).toEqual(['page_id', 'page_id']);
      expect(swapped.run.counts).toMatchObject({ added: 0, removed: 0, unchanged: 2 });
      expect(swapped.pages.get(1)!.file_id).toBe(first.pages.get(2)!.file_id);
      expect(swapped.pages.get(2)!.file_id).toBe(first.pages.get(1)!.file_id);
    });

    it('falls back to titles when the ids are new but the names came along', async () => {
      const { deckId } = await scenario('canva-new-ids-same-titles');

      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha'), pageId: P1 },
        { title: 'Beta', bytes: png('beta'), pageId: P2 },
      ]);
      await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha'), pageId: P1 },
        { title: 'Beta', bytes: png('beta'), pageId: P2 },
      ]);

      // Not what duplicating a design does -- that carries every page id across
      // -- but what rebuilding the artwork somewhere else does: fresh ids under
      // the names people already gave the cards. The titles are what keeps the
      // deck.
      const copied = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha'), pageId: 'MAHcopy0001' },
        { title: 'Beta', bytes: png('beta'), pageId: 'MAHcopy0002' },
      ]);

      expect(matches(copied.pages)).toEqual(['identity', 'identity']);
      expect(copied.run.counts).toMatchObject({ added: 0, removed: 0 });
      expect(copied.pages.get(1)!.file_id).toBe(first.pages.get(1)!.file_id);
    });

    it('tells two pages with one title apart by their ids', async () => {
      const { deckId } = await scenario('canva-duplicated-page');

      // Duplicating a page in Canva mints a new id and keeps the title, so a
      // deck really does end up holding two pages called the same thing. The
      // title tier cannot separate them and the page-number tier only manages
      // it while nobody reorders anything.
      const first = await importPages(deckId, [
        { title: 'Back', bytes: png('back'), pageId: P1 },
        { title: 'Back', bytes: png('back alternate'), pageId: P2 },
        { title: 'Red', bytes: png('red'), pageId: P3 },
      ]);
      await importPages(deckId, [
        { title: 'Back', bytes: png('back'), pageId: P1 },
        { title: 'Back', bytes: png('back alternate'), pageId: P2 },
        { title: 'Red', bytes: png('red'), pageId: P3 },
      ]);

      // The two namesakes swap places. Only the id says which is which.
      const swapped = await importPages(deckId, [
        { title: 'Back', bytes: png('back alternate'), pageId: P2 },
        { title: 'Back', bytes: png('back'), pageId: P1 },
        { title: 'Red', bytes: png('red'), pageId: P3 },
      ]);

      expect(matches(swapped.pages)).toEqual(['page_id', 'page_id', 'page_id']);
      expect(swapped.run.counts).toMatchObject({ added: 0, removed: 0, unchanged: 3 });
      expect(swapped.pages.get(1)!.file_id).toBe(first.pages.get(2)!.file_id);
      expect(swapped.pages.get(2)!.file_id).toBe(first.pages.get(1)!.file_id);
    });

    // The page id is what the strongest tier reads, and a manifest without one
    // can only be matched by title and number. Refusing it is how a caller
    // hears about that, rather than the import quietly landing weaker.
    it('refuses a manifest whose page names no id', async () => {
      const { deckId } = await scenario('canva-missing-id');
      const res = await owner.api.post(`/api/decks/${deckId}/import/runs`, {
        pages: [{ page_number: 1, title: 'Alpha' }],
      });

      expect(res.status).toBe(422);
      expect(await timeline(deckId)).toEqual([]);
    });

    it('refuses a manifest that gives two pages one id', async () => {
      const { deckId } = await scenario('canva-duplicate-ids');
      const res = await startRun(deckId, 2, owner, [
        { title: 'Alpha', bytes: png('alpha'), pageId: P1 },
        { title: 'Beta', bytes: png('beta'), pageId: P1 },
      ]);
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatch(/page id/iu);
    });

    it('lets a page id outrank a title another page holds', async () => {
      const { deckId } = await scenario('canva-id-outranks-title');

      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha'), pageId: P1 },
        { title: 'Beta', bytes: png('beta'), pageId: P2 },
      ]);
      await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha'), pageId: P1 },
        { title: 'Beta', bytes: png('beta'), pageId: P2 },
      ]);

      // The two titles have been swapped between the pages. Ids settle first,
      // so each card stays with the page it has always been, and the titles
      // follow the artwork rather than dragging it.
      const swapped = await importPages(deckId, [
        { title: 'Beta', bytes: png('alpha'), pageId: P1 },
        { title: 'Alpha', bytes: png('beta'), pageId: P2 },
      ]);

      expect(matches(swapped.pages)).toEqual(['page_id', 'page_id']);
      expect(swapped.run.counts).toMatchObject({ added: 0, removed: 0 });
      expect(swapped.pages.get(1)!.file_id).toBe(first.pages.get(1)!.file_id);
      expect(swapped.pages.get(2)!.file_id).toBe(first.pages.get(2)!.file_id);
    });
  });

  describe('the deck as it stood', () => {
    it('names the cards a finished run left, each at the version that run left it', async () => {
      const { deckId } = await scenario('as-of-versions');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const alpha = first.pages.get(1)!.file_id!;
      const beta = first.pages.get(2)!.file_id!;

      const atFirst = await asOf(deckId, first.run.id);
      expect(atFirst.run.id).toBe(first.run.id);
      expect(atFirst.has_purged_history).toBe(false);
      expect(atFirst.cards).toMatchObject([
        { file_id: alpha, name: '1 - Alpha.png', file_version_number: 1, page_number: 1 },
        { file_id: beta, name: '2 - Beta.png', file_version_number: 1, page_number: 2 },
      ]);
      expect(atFirst.cards.every((card) => card.last_run_id === first.run.id)).toBe(true);

      const second = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha redrawn') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      expect(await asOf(deckId, second.run.id)).toMatchObject({
        cards: [
          { file_id: alpha, file_version_number: 2, outcome: 'updated' },
          { file_id: beta, file_version_number: 1, outcome: 'unchanged' },
        ],
      });

      // The earlier run keeps answering with the artwork it left, which is the
      // whole point of asking it.
      expect((await asOf(deckId, first.run.id)).cards.map((card) => card.file_version_number)) //
        .toEqual([1, 1]);
    });

    it('leaves out a card that had not been imported yet', async () => {
      const { deckId } = await scenario('as-of-before-it-arrived');
      const first = await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);
      const second = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);

      expect((await asOf(deckId, first.run.id)).cards.map((card) => card.name)).toEqual([
        '1 - Alpha.png',
      ]);
      expect((await asOf(deckId, second.run.id)).cards.map((card) => card.name)).toEqual([
        '1 - Alpha.png',
        '2 - Beta.png',
      ]);
    });

    it('leaves out a card that import removed', async () => {
      const { deckId } = await scenario('as-of-after-a-removal');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const second = await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);
      expect(second.run.counts.removed).toBe(1);

      expect((await asOf(deckId, second.run.id)).cards.map((card) => card.name)).toEqual([
        '1 - Alpha.png',
      ]);
      expect((await asOf(deckId, first.run.id)).cards).toHaveLength(2);
    });

    // An abandoned run writes real ledger rows: its pages landed, its versions
    // are on disk, and the deck was handed none of it. status = 'finished' is
    // the whole of what keeps those rows out of this answer.
    it('leaves out an abandoned run inside a later window', async () => {
      const { deckId } = await scenario('as-of-abandoned-in-window');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const alpha = first.pages.get(1)!.file_id!;
      const beta = first.pages.get(2)!.file_id!;

      const pages: Page[] = [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta redrawn') },
      ];
      const abandoned = await openRun(deckId, 2, pages);
      expect((await landPage(abandoned.id, 2, pages[1])).file_version_number).toBe(2);
      expect((await abandon(abandoned.id)).status).toBe(200);

      // Tombstoned by hand so the run after it neither matches nor removes it:
      // its newest finished row stays the one the first run wrote.
      expect((await owner.api.delete(`/api/files/${beta}`)).status).toBe(204);
      const third = await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);

      const at = await asOf(deckId, third.run.id);
      expect(at.has_purged_history).toBe(false);
      expect(at.cards).toMatchObject([
        { file_id: alpha, file_version_number: 1, last_run_id: third.run.id },
        { file_id: beta, file_version_number: 1, last_run_id: first.run.id },
      ]);
    });

    it('still lists a card whose file was moved out of the folder', async () => {
      const { deckId } = await scenario('as-of-detached');
      const elsewhere = await makeFolder('as-of-detached-destination');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const moved = first.pages.get(2)!.file_id!;
      expect(
        (await owner.api.post(`/api/files/${moved}/move`, { folder_id: elsewhere })).status
      ).toBe(200);

      const second = await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha redrawn') }]);
      expect(second.run.counts.removed).toBe(0);

      // Detaching takes a card out of the import, never out of the deck, so the
      // carry-forward is the honest answer rather than a hole.
      expect((await asOf(deckId, second.run.id)).cards).toMatchObject([
        {
          file_id: first.pages.get(1)!.file_id,
          file_version_number: 2,
          last_run_id: second.run.id,
        },
        { file_id: moved, file_version_number: 1, last_run_id: first.run.id },
      ]);
    });

    it('still lists a card somebody deleted by hand, and dates the tombstone', async () => {
      const { deckId } = await scenario('as-of-hand-deleted');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const beta = first.pages.get(2)!.file_id!;
      expect((await owner.api.delete(`/api/files/${beta}`)).status).toBe(204);

      const cards = (await asOf(deckId, first.run.id)).cards;
      expect(cards[0]).toMatchObject({ file_id: first.pages.get(1)!.file_id });
      expect(cards[0].image_deleted_at).toBeNull();
      expect(cards[1].file_id).toBe(beta);
      // The tombstone's own timestamp, not a boolean evaluated now: only a date
      // can say whether it was stamped before or after the run being read.
      expect(cards[1].image_deleted_at).not.toBeNull();
      expect(cards[1].image_deleted_at).toBe((await readFile(beta)).body.deleted_at);
      expect((await readDeck(deckId)).cards).toHaveLength(2);
    });

    // The badge the screen draws is anchored to the run in front of somebody,
    // and one tombstone is after one run and before the next.
    it('dates the tombstone the same way whichever run is asked', async () => {
      const { deckId } = await scenario('as-of-tombstone-dated');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const beta = first.pages.get(2)!.file_id!;
      await tick();
      expect((await owner.api.delete(`/api/files/${beta}`)).status).toBe(204);
      await tick();

      // A card already tombstoned is not one this run removed, so it carries
      // forward and the later run has an answer about it too.
      const second = await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha redrawn') }]);
      expect(second.run.counts.removed).toBe(0);

      const atFirst = (await asOf(deckId, first.run.id)).cards.find(
        (card) => card.file_id === beta
      )!;
      const atSecond = (await asOf(deckId, second.run.id)).cards.find(
        (card) => card.file_id === beta
      )!;

      expect(atSecond.image_deleted_at).toBe(atFirst.image_deleted_at);
      expect(Date.parse(atFirst.image_deleted_at!)).toBeGreaterThan(
        Date.parse(first.run.finished_at!)
      );
      expect(Date.parse(atSecond.image_deleted_at!)).toBeLessThan(
        Date.parse(second.run.finished_at!)
      );
    });

    it('leaves out a card somebody added to the deck by hand', async () => {
      const { deckId } = await scenario('as-of-hand-added');
      const first = await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);
      const byHand = await uploadByHand(deckId, 'chosen.png', png('chosen'));

      const cards = [
        { file_id: first.pages.get(1)!.file_id!, quantity: 1 },
        { file_id: byHand, quantity: 1 },
      ];
      expect((await owner.api.put(`/api/decks/${deckId}/cards`, { cards })).status).toBe(200);

      expect((await readDeck(deckId)).cards).toHaveLength(2);
      expect((await asOf(deckId, first.run.id)).cards.map((card) => card.file_id)).toEqual([
        first.pages.get(1)!.file_id,
      ]);
    });

    it('leaves out a purged card and says some history is gone', async () => {
      const { deckId } = await scenario('as-of-purged');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const beta = first.pages.get(2)!.file_id!;
      expect((await owner.api.delete(`/api/files/${beta}`)).status).toBe(204);
      expect((await owner.api.delete(`/api/files/${beta}?purge=true`)).status).toBe(204);

      const at = await asOf(deckId, first.run.id);
      expect(at.cards.map((card) => card.file_id)).toEqual([first.pages.get(1)!.file_id]);
      expect(at.has_purged_history).toBe(true);
    });

    it('refuses a run that is still open', async () => {
      const { deckId } = await scenario('as-of-open-run');
      const run = await openRun(deckId, 1, [{ title: 'Alpha', bytes: png('alpha') }]);

      const res = await asOfRes(deckId, run.id);
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 409,
        body: { error: 'That import is still running. Finish it before asking what it left' },
      });
      expect((await abandon(run.id)).status).toBe(200);
    });

    it('refuses an abandoned run, whose pages the deck was never handed', async () => {
      const { deckId } = await scenario('as-of-abandoned');
      const pages: Page[] = [{ title: 'Alpha', bytes: png('alpha') }];
      const run = await openRun(deckId, 1, pages);
      await landPage(run.id, 1, pages[0]);
      expect((await abandon(run.id)).status).toBe(200);

      const res = await asOfRes(deckId, run.id);
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 409,
        body: { error: 'That import was abandoned. It handed the deck nothing' },
      });
    });

    it('answers 404 for a run belonging to another deck', async () => {
      const mine = await scenario('as-of-this-deck');
      const theirs = await scenario('as-of-another-deck');
      await importPages(mine.deckId, [{ title: 'Alpha', bytes: png('alpha') }]);
      const other = await importPages(theirs.deckId, [{ title: 'Alpha', bytes: png('alpha') }]);

      expect((await asOfRes(theirs.deckId, other.run.id)).status).toBe(200);
      const res = await asOfRes(mine.deckId, other.run.id);
      expect({ status: res.status, body: await res.json() }).toEqual({
        status: 404,
        body: { error: 'Import run not found' },
      });
    });

    it('is readable by a viewer and 404 for a stranger', async () => {
      const { deckId } = await scenario('as-of-guarded');
      const first = await importPages(deckId, [{ title: 'Alpha', bytes: png('alpha') }]);

      expect((await asOfRes(deckId, first.run.id, viewer)).status).toBe(200);
      expect((await asOfRes(deckId, first.run.id, stranger)).status).toBe(404);
    });

    it('orders two cards that share a page number the same way twice', async () => {
      const { deckId } = await scenario('as-of-page-collision');
      const elsewhere = await makeFolder('as-of-page-collision-destination');
      const first = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Beta', bytes: png('beta') },
      ]);
      const moved = first.pages.get(2)!.file_id!;
      expect(
        (await owner.api.post(`/api/files/${moved}/move`, { folder_id: elsewhere })).status
      ).toBe(200);

      // Gamma takes the page number Beta's card is still carrying from the run
      // before, so the page number alone cannot decide the order.
      const second = await importPages(deckId, [
        { title: 'Alpha', bytes: png('alpha') },
        { title: 'Gamma', bytes: png('gamma') },
      ]);
      const expected = ['1 - Alpha.png', '2 - Beta.png', '2 - Gamma.png'];
      expect((await asOf(deckId, second.run.id)).cards.map((card) => card.name)).toEqual(expected);
      expect((await asOf(deckId, second.run.id)).cards.map((card) => card.name)).toEqual(expected);
    });
  });

  describe('authorization', () => {
    let deckId: string;
    let runId: string;

    beforeAll(async () => {
      ({ deckId } = await scenario('guarded-import'));
      runId = (await openRun(deckId, 1)).id;
    });

    afterAll(async () => {
      await abandon(runId);
    });

    it('lets a viewer read the binding and the timeline', async () => {
      expect((await readImport(deckId, viewer)).status).toBe(200);
      expect((await viewer.api.get(`/api/decks/${deckId}/import/runs`)).status).toBe(200);
      expect((await viewer.api.get(`/api/decks/${deckId}/import/runs/${runId}`)).status).toBe(200);
    });

    it.each([
      ['starting a run', (user: TestUser) => startRun(deckId, 1, user)],
      ['importing a page', (user: TestUser) => postPage(runId, 1, png('viewer'), 'Alpha', user)],
      ['finishing a run', (user: TestUser) => finish(runId, user)],
      ['abandoning a run', (user: TestUser) => abandon(runId, user)],
    ])('refuses a viewer %s with 403', async (_name, act) => {
      expect((await act(viewer)).status).toBe(403);
    });

    // 403 would tell an outsider that this deck exists and is being imported.
    it.each([
      ['reading the binding', (user: TestUser) => user.api.get(`/api/decks/${deckId}/import`)],
      ['starting a run', (user: TestUser) => startRun(deckId, 1, user)],
      [
        'reading a run',
        (user: TestUser) => user.api.get(`/api/decks/${deckId}/import/runs/${runId}`),
      ],
      ['importing a page', (user: TestUser) => postPage(runId, 1, png('stranger'), 'Alpha', user)],
      ['finishing a run', (user: TestUser) => finish(runId, user)],
    ])('answers a stranger %s with 404', async (_name, act) => {
      expect((await act(stranger)).status).toBe(404);
    });

    it('answers 404 for a deck nobody has bound', async () => {
      const lonely = await makeDeck('Never imported');
      const res = await owner.api.get(`/api/decks/${lonely}/import`);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('This deck has no import');
    });
  });
});
