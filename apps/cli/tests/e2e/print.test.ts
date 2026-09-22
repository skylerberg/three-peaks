import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { components } from '@three-peaks/shared/api';
import { deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { pngBytes, signedInHarness, type CliHarness } from './helpers.ts';

type PrintOutstanding = components['schemas']['PrintOutstanding'];

describe('print outstanding', () => {
  let h: CliHarness;
  let owner: TestUser;
  let projectId: string;
  let starterId: string;
  const cards: Record<string, string> = {};
  let seed = 200;

  function cli(args: string[]) {
    return h.runCli([...args, '--project', projectId]);
  }

  async function deck(name: string): Promise<string> {
    const res = await owner.api.post('/api/decks', {
      project_id: projectId,
      name,
      card_width_mm: 63,
      card_height_mm: 88,
    });
    return (await res.json()).id as string;
  }

  async function upload(deckId: string, filename: string): Promise<void> {
    seed += 1;
    const query = new URLSearchParams({ project_id: projectId, filename, deck_id: deckId });
    const res = await owner.api.postBytes(
      `/api/files/upload?${query}`,
      pngBytes(seed) as unknown as BodyInit,
      'image/png'
    );
    cards[filename] = (await res.json()).id;
  }

  beforeAll(async () => {
    ({ h, user: owner } = await signedInHarness('cli-print'));
    projectId = (await (await owner.api.post('/api/projects', { name: 'Print' })).json()).id;
    starterId = await deck('Starter');
    await upload(starterId, 'hero.png');
    await upload(starterId, 'villain.png');
    const expansion = await deck('Expansion');
    await upload(expansion, 'dragon.png');

    // The hero is on paper at its current artwork; the villain never was.
    const recorded = await owner.api.post('/api/print/runs', {
      project_id: projectId,
      cards: [{ file_id: cards['hero.png'], version_number: 1, copies: 1 }],
    });
    expect(recorded.status).toBe(201);
  });

  afterAll(async () => {
    await deleteUser(owner);
  });

  it('names each deck and card that still owes copies, and why', async () => {
    const res = await cli(['print', 'outstanding']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Expansion — 1 copy owed (never printed)');
    expect(res.stdout).toMatch(/Starter — 1 copy owed \(last printed \d{4}-\d{2}-\d{2}\)/);
    expect(res.stdout).toMatch(/villain\.png\s+1\s+0\s+1\s+v1\s+never printed/);
    expect(res.stdout).not.toContain('hero.png');
  });

  it('lists the cards owing nothing with --all', async () => {
    const res = await cli(['print', 'outstanding', '--all']);
    expect(res.stdout).toMatch(/hero\.png\s+0\s+1\s+1\s+v1/);
  });

  it('narrows to one deck, keeping the API shape under --json', async () => {
    const res = await cli(['print', 'outstanding', '--deck', 'Starter', '--json']);
    expect(res.exitCode).toBe(0);
    const payload = res.json<PrintOutstanding>();
    expect(payload.decks.map((d) => d.deck_id)).toEqual([starterId]);
    expect(payload.decks[0].cards.map((c) => c.file_id)).toEqual([cards['villain.png']]);
    expect(payload.decks[0].cards[0].reason).toBe('never');
  });

  it('says how many more when a copy count has gone up', async () => {
    const full = await (await owner.api.get(`/api/decks/${starterId}`)).json();
    await owner.api.put(`/api/decks/${starterId}/cards`, {
      cards: full.cards.map((c: { file_id: string; quantity: number }) => ({
        file_id: c.file_id,
        quantity: c.file_id === cards['hero.png'] ? 3 : c.quantity,
      })),
    });
    const res = await cli(['print', 'outstanding', '--deck', 'Starter']);
    expect(res.stdout).toMatch(/hero\.png\s+2\s+1\s+3\s+v1\s+2 more/);
  });
});
