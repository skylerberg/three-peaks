import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { components } from '@three-peaks/shared/api';
import { deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { pngBytes, signedInHarness, type CliHarness } from './helpers.ts';

type Schemas = components['schemas'];
type ImportRun = Schemas['ImportRun'];
type ImportRunDetail = Schemas['ImportRunDetail'];
type ImportRunDeck = Schemas['ImportRunDeck'];
type DeckImport = Schemas['DeckImport'];

// There is no way to import from the CLI, so the history it reads is written
// the way the Canva app writes it: straight at the API.
describe('deck import history', () => {
  let h: CliHarness;
  let owner: TestUser;
  let projectId: string;
  let deckId: string;
  let finished: ImportRun;
  let open: ImportRun;
  let seed = 100;

  function cli(args: string[], options?: Parameters<CliHarness['runCli']>[1]) {
    return h.runCli([...args, '--project', projectId], options);
  }

  async function startRun(titles: string[]): Promise<ImportRun> {
    const res = await owner.api.post(`/api/decks/${deckId}/import/runs`, {
      source_label: 'Canva: Test design',
      pages: titles.map((title, index) => ({
        page_number: index + 1,
        title,
        page_id: `page-${title}`,
      })),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as ImportRun;
  }

  async function landPage(runId: string, pageNumber: number, title: string): Promise<void> {
    seed += 1;
    const query = new URLSearchParams({ page_number: String(pageNumber), title });
    const res = await owner.api.postBytes(
      `/api/decks/import/runs/${runId}/pages?${query}`,
      pngBytes(seed) as unknown as BodyInit,
      'image/png'
    );
    expect([200, 201]).toContain(res.status);
  }

  beforeAll(async () => {
    ({ h, user: owner } = await signedInHarness('cli-import'));
    projectId = (await (await owner.api.post('/api/projects', { name: 'Imports' })).json()).id;
    const deck = await owner.api.post('/api/decks', {
      id: randomUUID(),
      project_id: projectId,
      name: 'Imported',
      card_width_mm: 63,
      card_height_mm: 88,
    });
    deckId = (await deck.json()).id;
    await owner.api.post('/api/decks', {
      project_id: projectId,
      name: 'Never imported',
      card_width_mm: 63,
      card_height_mm: 88,
    });

    const first = await startRun(['Ace', 'King']);
    await landPage(first.id, 1, 'Ace');
    await landPage(first.id, 2, 'King');
    const done = await owner.api.post(`/api/decks/import/runs/${first.id}/finish`);
    expect(done.status).toBe(200);
    finished = ((await done.json()) as ImportRunDetail).run;

    // Left open, the way a closed Canva tab leaves one.
    open = await startRun(['Ace', 'Queen']);
    await landPage(open.id, 1, 'Ace');
  });

  afterAll(async () => {
    await deleteUser(owner);
  });

  it('says a deck nothing has been imported into has no history, without failing', async () => {
    const status = await cli(['deck', 'import', 'status', 'Never imported']);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('Nothing has been imported into Never imported');
    expect((await cli(['deck', 'import', 'status', 'Never imported', '--json'])).json()).toBeNull();

    const runs = await cli(['deck', 'import', 'runs', 'Never imported', '--json']);
    expect(runs.json()).toEqual([]);
  });

  it('reports the open run, and the one that last finished', async () => {
    const res = await cli(['deck', 'import', 'status', 'Imported']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('last imported from Canva: Test design');
    expect(res.stdout).toContain(`Last finished: Import ${finished.id.slice(0, 8)}`);
    expect(res.stdout).toContain(`Open: Import ${open.id.slice(0, 8)}`);
    expect(res.stdout).toContain('1 of 2 pages landed');

    const json = (await cli(['deck', 'import', 'status', 'Imported', '--json'])).json<DeckImport>();
    expect(json.open_run_id).toBe(open.id);
  });

  it('lists the runs newest first', async () => {
    const res = await cli(['deck', 'import', 'runs', 'Imported', '--json']);
    expect(res.json<ImportRun[]>().map((run) => run.id)).toEqual([open.id, finished.id]);

    const human = await cli(['deck', 'import', 'runs', 'Imported']);
    expect(human.stdout).toMatch(new RegExp(`${finished.id.slice(0, 8)}.*finished\\s+2/2\\s+2`));
  });

  it('shows one run by id prefix, and the newest as "latest"', async () => {
    const res = await cli(['deck', 'import', 'show', 'Imported', finished.id.slice(0, 6)]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('2 added, 0 updated, 0 unchanged, 0 removed');
    expect(res.stdout).toMatch(/added\s+1\s+1 - Ace\.png\s+v1\s+new card/);

    const latest = await cli(['deck', 'import', 'show', 'Imported', 'latest', '--json']);
    expect(latest.json<ImportRunDetail>().run.id).toBe(open.id);

    const missing = await cli(['deck', 'import', 'show', 'Imported', 'ffffffff']);
    expect(missing.exitCode).toBe(4);
  });

  it('reads the deck as of a finished run, and refuses one still open', async () => {
    const res = await cli(['deck', 'import', 'as-of', 'Imported', finished.id, '--json']);
    expect(res.exitCode).toBe(0);
    expect(
      res
        .json<ImportRunDeck>()
        .cards.map((card) => card.name)
        .sort()
    ).toEqual(['1 - Ace.png', '2 - King.png']);

    const still = await cli(['deck', 'import', 'as-of', 'Imported', open.id]);
    expect(still.exitCode).toBe(5);
    expect(still.stderr).toContain('still running');
  });

  it('abandons the open run only when confirmed, and is a no-op once none is open', async () => {
    const refused = await cli(['deck', 'import', 'abandon', 'Imported', '--no-input']);
    expect(refused.exitCode).toBe(2);

    const abandoned = await cli(['deck', 'import', 'abandon', 'Imported', '--force']);
    expect(abandoned.exitCode).toBe(0);
    expect(abandoned.stdout).toContain(`Abandoned import ${open.id.slice(0, 8)}`);

    const status = (
      await cli(['deck', 'import', 'status', 'Imported', '--json'])
    ).json<DeckImport>();
    expect(status.open_run_id).toBeNull();

    const again = await cli(['deck', 'import', 'abandon', 'Imported', '--json']);
    expect(again.exitCode).toBe(0);
    expect(again.json()).toEqual({ abandoned: null });

    const asOf = await cli(['deck', 'import', 'as-of', 'Imported', open.id]);
    expect(asOf.exitCode).toBe(5);
    expect(asOf.stderr).toContain('abandoned');
  });
});
