import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CARD_SETTINGS } from '@three-peaks/shared';
import type { components } from '@three-peaks/shared/api';
import type { UploadResult } from '../../src/transfer.ts';
import { createUser, deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import {
  API_URL,
  createCliHarness,
  pngBytes,
  signedInHarness,
  type CliHarness,
} from './helpers.ts';

type Deck = components['schemas']['Deck'];
type DeckWithCards = components['schemas']['DeckWithCards'];

interface ModelView {
  file_id: string;
  saved: boolean;
  settings: Record<string, unknown>;
}

describe('deck commands', () => {
  let h: CliHarness;
  let owner: TestUser;
  let viewer: TestUser;
  let projectId: string;
  let fixtures: string;
  let seed = 0;

  function cli(args: string[], options?: Parameters<CliHarness['runCli']>[1]) {
    return h.runCli([...args, '--project', projectId], options);
  }

  // A distinct image per call, so no two uploads are the identical-bytes no-op.
  async function fixture(name: string): Promise<string> {
    seed += 1;
    const path = join(fixtures, name);
    await writeFile(path, pngBytes(seed));
    return path;
  }

  async function deckJson(ref: string): Promise<DeckWithCards> {
    const res = await cli(['deck', 'show', ref, '--json']);
    expect(res.exitCode).toBe(0);
    return res.json<DeckWithCards>();
  }

  async function newDeck(name: string, cards: string[]): Promise<DeckWithCards> {
    expect((await cli(['deck', 'create', name])).exitCode).toBe(0);
    if (cards.length > 0) {
      const paths = await Promise.all(cards.map((card) => fixture(card)));
      const res = await cli(['deck', 'upload', name, ...paths]);
      expect(res.stderr).toBe('');
      expect(res.exitCode).toBe(0);
    }
    return deckJson(name);
  }

  const names = (deck: DeckWithCards) => deck.cards.map((card) => card.file.filename);

  beforeAll(async () => {
    ({ h, user: owner } = await signedInHarness('cli-deck'));
    viewer = await createUser('cli-deck-viewer');
    projectId = (await (await owner.api.post('/api/projects', { name: 'Decks' })).json()).id;
    await owner.api.put(`/api/projects/${projectId}/members`, {
      email: viewer.email,
      role: 'viewer',
    });
    fixtures = join(h.workDir, 'fixtures');
    await mkdir(fixtures, { recursive: true });
  });

  afterAll(async () => {
    await deleteUser(owner);
    await deleteUser(viewer);
  });

  describe('creating and listing', () => {
    it('creates a deck at the default size and lists it', async () => {
      const created = await cli(['deck', 'create', 'Main', '--json']);
      expect(created.exitCode).toBe(0);
      const deck = created.json<Deck>();
      expect(deck).toMatchObject({ name: 'Main', card_width_mm: 63, card_height_mm: 88 });

      const list = await cli(['deck', 'list']);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain('Main');
      expect(list.stdout).toContain('Poker (63 × 88 mm)');
    });

    it('takes a named size or explicit millimetres, and refuses both at once', async () => {
      const tarot = await cli(['deck', 'create', 'Tarot deck', '--size', 'tarot', '--json']);
      expect(tarot.json<Deck>()).toMatchObject({ card_width_mm: 70, card_height_mm: 120 });

      const custom = await cli([
        'deck',
        'create',
        'Custom',
        '--width',
        '60',
        '--height',
        '90',
        '--json',
      ]);
      expect(custom.json<Deck>()).toMatchObject({ card_width_mm: 60, card_height_mm: 90 });

      const both = await cli(['deck', 'create', 'Nope', '--size', 'poker', '--width', '60']);
      expect(both.exitCode).toBe(2);
      expect(both.stderr).toContain('not both');

      const half = await cli(['deck', 'create', 'Nope', '--width', '60']);
      expect(half.exitCode).toBe(2);
      expect(half.stderr).toContain('--width and --height');
    });

    it('answers a duplicate name with a conflict', async () => {
      const again = await cli(['deck', 'create', 'Main']);
      expect(again.exitCode).toBe(5);
      expect(again.stderr).toContain('already exists');
    });

    it('lists the named sizes without needing a project', async () => {
      const sizes = await h.runCli(['deck', 'sizes']);
      expect(sizes.exitCode).toBe(0);
      expect(sizes.stdout).toContain('poker (default)');
      expect(sizes.stdout).toContain('Tarot (70 × 120 mm)');
    });

    it('renames a deck and changes its size', async () => {
      await cli(['deck', 'create', 'Renamable']);
      const res = await cli(['deck', 'update', 'Renamable', '--name', 'Renamed', '--size', 'mini']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Updated Renamed — Mini (44 × 67 mm)');

      const nothing = await cli(['deck', 'update', 'Renamed']);
      expect(nothing.exitCode).toBe(2);
    });
  });

  describe('uploading and showing', () => {
    it('uploads cards in the order given and shows them in print order', async () => {
      const deck = await newDeck('Upload order', ['one.png', 'two.png', 'three.png']);
      expect(names(deck)).toEqual(['one.png', 'two.png', 'three.png']);

      const shown = await cli(['deck', 'show', 'Upload order']);
      expect(shown.stdout).toContain('3 cards · 3 to print');
      expect(shown.stdout).toContain('Back: none');
      expect(shown.stdout).toMatch(/1\s+1\s+one\.png/);
    });

    it('refuses a clashing name, then replaces it as a new version with --replace', async () => {
      await newDeck('Replacing', ['ace.png']);
      const path = await fixture('ace.png');

      const clash = await cli(['deck', 'upload', 'Replacing', path]);
      expect(clash.exitCode).toBe(5);
      expect(clash.stderr).toContain('pass --replace');

      const replaced = await cli(['deck', 'upload', 'Replacing', path, '--replace', '--json']);
      expect(replaced.exitCode).toBe(0);
      const [outcome] = replaced.json<UploadResult[]>();
      expect(outcome).toMatchObject({ outcome: 'versioned', version: { version_number: 2 } });

      const again = await cli(['deck', 'upload', 'Replacing', path, '--replace']);
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toContain('Unchanged ace.png: identical to version 2');

      expect(names(await deckJson('Replacing'))).toEqual(['ace.png']);
    });

    it('keeps going past a failed upload and exits with its code', async () => {
      await newDeck('Partial', ['taken.png']);
      const clash = await fixture('taken.png');
      const fresh = await fixture('fresh.png');

      const res = await cli(['deck', 'upload', 'Partial', clash, fresh]);
      expect(res.exitCode).toBe(5);
      expect(res.stdout).toContain('Uploaded fresh.png');
      expect(res.stderr).toContain('1 of 2 uploads failed');
      expect(names(await deckJson('Partial'))).toEqual(['taken.png', 'fresh.png']);
    });

    it('uploads a back as a card holding no copies, so it can be chosen again later', async () => {
      await newDeck('With back', ['front.png']);
      const res = await cli(['deck', 'upload', 'With back', await fixture('back.png'), '--back']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Uploaded back.png to With back as its back');

      const deck = await deckJson('With back');
      const back = deck.cards.find((card) => card.file.filename === 'back.png');
      expect(back?.quantity).toBe(0);
      expect(deck.deck.back_file_id).toBe(back?.file_id);
      expect(deck.deck.total_copies).toBe(1);

      // A second back leaves the first as an ordinary card, and the deck still
      // saves: a back uploaded with no place in the list would now be refused.
      await cli(['deck', 'upload', 'With back', await fixture('back2.png'), '--back']);
      const copies = await cli(['deck', 'copies', 'With back', 'front.png', '2']);
      expect(copies.exitCode).toBe(0);

      const shown = await cli(['deck', 'show', 'With back']);
      expect(shown.stdout).toContain('Back: back2.png');
      expect(shown.stdout).toMatch(/back2\.png\s+\S+\s+the deck's back/);
    });

    it('refuses more than one image with --back', async () => {
      const res = await cli([
        'deck',
        'upload',
        'Main',
        await fixture('b1.png'),
        await fixture('b2.png'),
        '--back',
      ]);
      expect(res.exitCode).toBe(2);
    });
  });

  describe('arranging cards', () => {
    it('sets a copy count, zero included, and writes nothing when it is unchanged', async () => {
      await newDeck('Copies', ['a.png', 'b.png']);
      const three = await cli(['deck', 'copies', 'Copies', 'a.png', '3']);
      expect(three.exitCode).toBe(0);
      expect(three.stdout).toContain('a.png: 3 copies (Copies is now 2 cards · 4 to print)');

      const zero = await cli(['deck', 'copies', 'Copies', 'b', '0', '--json']);
      expect(zero.json<DeckWithCards>().deck.total_copies).toBe(3);

      const methods: string[] = [];
      const same = await cli(['deck', 'copies', 'Copies', 'a.png', '3'], {
        onRequest: (request) => methods.push(request.method),
      });
      expect(same.stdout).toContain('already has 3 copies');
      expect(methods).not.toContain('PUT');

      const bad = await cli(['deck', 'copies', 'Copies', 'a.png', '1000']);
      expect(bad.exitCode).toBe(6);
    });

    it('moves a card by each kind of placement', async () => {
      await newDeck('Order', ['a.png', 'b.png', 'c.png', 'd.png']);

      await cli(['deck', 'move-card', 'Order', 'c.png', '--top']);
      expect(names(await deckJson('Order'))).toEqual(['c.png', 'a.png', 'b.png', 'd.png']);

      await cli(['deck', 'move-card', 'Order', 'c.png', '--bottom']);
      expect(names(await deckJson('Order'))).toEqual(['a.png', 'b.png', 'd.png', 'c.png']);

      await cli(['deck', 'move-card', 'Order', 'c.png', '--before', 'b.png']);
      expect(names(await deckJson('Order'))).toEqual(['a.png', 'c.png', 'b.png', 'd.png']);

      await cli(['deck', 'move-card', 'Order', 'a.png', '--after', 'd.png']);
      expect(names(await deckJson('Order'))).toEqual(['c.png', 'b.png', 'd.png', 'a.png']);

      const moved = await cli(['deck', 'move-card', 'Order', 'a.png', '--position', '2']);
      expect(moved.stdout).toContain('Moved a.png to position 2 of 4');
      expect(names(await deckJson('Order'))).toEqual(['c.png', 'a.png', 'b.png', 'd.png']);
    });

    it('writes nothing for a card put back where it was, and wants exactly one placement', async () => {
      await newDeck('Still', ['a.png', 'b.png']);
      const methods: string[] = [];
      const res = await cli(['deck', 'move-card', 'Still', 'b.png', '--after', 'a.png'], {
        onRequest: (request) => methods.push(request.method),
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('already at position 2 of 2');
      expect(methods).not.toContain('PUT');

      const none = await cli(['deck', 'move-card', 'Still', 'a.png']);
      expect(none.exitCode).toBe(2);
      const two = await cli(['deck', 'move-card', 'Still', 'a.png', '--top', '--bottom']);
      expect(two.exitCode).toBe(2);
    });

    it('keeps a deleted card in its slot, and arranges it only when asked for', async () => {
      const deck = await newDeck('Hidden', ['a.png', 'gone.png', 'b.png', 'c.png']);
      const gone = deck.cards.find((card) => card.file.filename === 'gone.png')!;
      expect((await owner.api.delete(`/api/files/${gone.file_id}`)).status).toBe(204);

      const shown = await cli(['deck', 'show', 'Hidden']);
      expect(shown.stdout).not.toContain('gone.png');
      expect(shown.stdout).toContain('1 deleted card hidden');
      const all = await cli(['deck', 'show', 'Hidden', '--all']);
      expect(all.stdout).toMatch(/gone\.png\s+\S+\s+deleted/);

      // c.png to the top of the drawn list; the hidden row keeps its slot.
      await cli(['deck', 'move-card', 'Hidden', 'c.png', '--top']);
      expect(names(await deckJson('Hidden'))).toEqual(['c.png', 'gone.png', 'a.png', 'b.png']);

      const refused = await cli(['deck', 'move-card', 'Hidden', 'gone.png', '--top']);
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain('pass --all');

      await cli(['deck', 'move-card', 'Hidden', 'gone.png', '--bottom', '--all']);
      expect(names(await deckJson('Hidden'))).toEqual(['c.png', 'a.png', 'b.png', 'gone.png']);

      // A copy count still saves with the tombstoned row in the list.
      expect((await cli(['deck', 'copies', 'Hidden', 'a.png', '4'])).exitCode).toBe(0);
    });

    it('chooses a back among the cards and clears it', async () => {
      await newDeck('Backs', ['front.png', 'reverse.png']);
      const set = await cli(['deck', 'back', 'Backs', 'reverse.png']);
      expect(set.exitCode).toBe(0);
      expect(set.stdout).toContain('The back of Backs is now reverse.png');

      const cleared = await cli(['deck', 'back', 'Backs', '--none', '--json']);
      expect(cleared.json<Deck>().back_file_id).toBeNull();

      const neither = await cli(['deck', 'back', 'Backs']);
      expect(neither.exitCode).toBe(2);
    });

    it('refuses a viewer with the forbidden exit code', async () => {
      await newDeck('Viewed', ['a.png']);
      const guest = await createCliHarness();
      await guest.credentials.set(API_URL, viewer.token);
      const res = await guest.runCli([
        'deck',
        'copies',
        'Viewed',
        'a.png',
        '2',
        '--project',
        projectId,
      ]);
      expect(res.exitCode).toBe(7);
    });
  });

  describe('3D settings', () => {
    it('shows the defaults sized to the deck for a card nobody has dialled in', async () => {
      await cli(['deck', 'create', 'Model deck', '--size', 'tarot']);
      await cli([
        'deck',
        'upload',
        'Model deck',
        await fixture('art.png'),
        await fixture('rev.png'),
      ]);

      const res = await cli(['deck', 'model', 'Model deck', 'art.png', '--json']);
      expect(res.exitCode).toBe(0);
      const view = res.json<ModelView>();
      expect(view.saved).toBe(false);
      expect(view.settings).toMatchObject({
        kind: 'card',
        width_mm: 70,
        height_mm: 120,
        thickness_mm: DEFAULT_CARD_SETTINGS.thickness_mm,
      });

      const human = await cli(['deck', 'model', 'Model deck', 'art.png']);
      expect(human.stdout).toContain('never dialled in');
      expect(human.stdout).toContain('width_mm = 70');
    });

    it('saves assignments, resolving a back named by its card', async () => {
      const res = await cli([
        'deck',
        'model',
        'Model deck',
        'art.png',
        '--set',
        'thickness_mm=0.5',
        '--set',
        'back_file_id=rev.png',
        '--json',
      ]);
      expect(res.exitCode).toBe(0);
      const view = res.json<ModelView>();
      const deck = await deckJson('Model deck');
      const rev = deck.cards.find((card) => card.file.filename === 'rev.png')!;
      expect(view).toMatchObject({ saved: true, settings: { thickness_mm: 0.5, width_mm: 70 } });
      expect(view.settings.back_file_id).toBe(rev.file_id);

      const shown = await cli(['deck', 'model', 'Model deck', 'art.png']);
      expect(shown.stdout).toContain(`back_file_id = ${rev.file_id} (rev.png)`);
    });

    it('lays a JSON file over the settings, and resets to the deck-sized defaults', async () => {
      const file = join(fixtures, 'settings.json');
      await writeFile(file, JSON.stringify({ corner_radius_mm: 4, back_file_id: null }));
      const merged = await cli([
        'deck',
        'model',
        'Model deck',
        'art.png',
        '--file',
        file,
        '--json',
      ]);
      expect(merged.json<ModelView>().settings).toMatchObject({
        corner_radius_mm: 4,
        thickness_mm: 0.5,
        back_file_id: null,
      });

      const reset = await cli(['deck', 'model', 'Model deck', 'art.png', '--reset', '--json']);
      expect(reset.json<ModelView>().settings).toMatchObject({
        thickness_mm: DEFAULT_CARD_SETTINGS.thickness_mm,
        width_mm: 70,
      });
    });

    it('refuses an unknown key, a changed kind and an out-of-range value', async () => {
      const unknown = await cli(['deck', 'model', 'Model deck', 'art.png', '--set', 'colour=red']);
      expect(unknown.exitCode).toBe(2);
      expect(unknown.stderr).toContain('No setting "colour"');

      const kind = await cli(['deck', 'model', 'Model deck', 'art.png', '--set', 'kind=box']);
      expect(kind.exitCode).toBe(2);

      const range = await cli(['deck', 'model', 'Model deck', 'art.png', '--set', 'width_mm=5000']);
      expect(range.exitCode).toBe(6);
    });
  });

  describe('downloading', () => {
    it('writes every live card and the back into a directory, refusing to overwrite', async () => {
      const deck = await newDeck('Download me', ['x.png', 'y.png']);
      await cli(['deck', 'upload', 'Download me', await fixture('behind.png'), '--back']);
      const dir = join(h.workDir, 'downloaded');

      const res = await cli(['deck', 'download', 'Download me', '-o', dir]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Wrote 3 files');
      expect((await readdir(dir)).sort()).toEqual(['behind.png', 'x.png', 'y.png']);
      const x = deck.cards.find((card) => card.file.filename === 'x.png')!;
      const expected = await (
        await owner.api.get(`/api/files/${x.file_id}/download`)
      ).arrayBuffer();
      expect(Buffer.compare(await readFile(join(dir, 'x.png')), Buffer.from(expected))).toBe(0);

      const again = await cli(['deck', 'download', 'Download me', '-o', dir]);
      expect(again.exitCode).toBe(5);
      expect(again.stderr).toContain('--force');

      const forced = await cli(['deck', 'download', 'Download me', '-o', dir, '--force']);
      expect(forced.exitCode).toBe(0);
    });
  });

  describe('deleting and restoring', () => {
    it('deletes softly and restores', async () => {
      await newDeck('Soft', ['s.png']);
      const deleted = await cli(['deck', 'delete', 'Soft']);
      expect(deleted.exitCode).toBe(0);
      expect(deleted.stdout).toContain('threepeaks deck restore "Soft"');
      expect((await cli(['deck', 'show', 'Soft'])).exitCode).toBe(4);

      const restored = await cli(['deck', 'restore', 'Soft']);
      expect(restored.exitCode).toBe(0);
      expect(restored.stdout).toContain('Restored Soft — 1 card · 1 to print');
    });

    it('purges only with confirmation, and reaches a deck already deleted', async () => {
      await newDeck('Purged', ['p.png']);
      const refused = await cli(['deck', 'delete', 'Purged', '--purge', '--no-input']);
      expect(refused.exitCode).toBe(2);
      expect(refused.stderr).toContain('--force');

      const declined = await cli(['deck', 'delete', 'Purged', '--purge'], { stdin: 'n\n' });
      expect(declined.exitCode).toBe(1);
      expect((await cli(['deck', 'show', 'Purged'])).exitCode).toBe(0);

      await cli(['deck', 'delete', 'Purged']);
      const purged = await cli(['deck', 'delete', 'Purged', '--purge', '--force']);
      expect(purged.exitCode).toBe(0);
      expect(purged.stdout).toContain('Permanently deleted Purged');
      expect((await cli(['deck', 'restore', 'Purged'])).exitCode).toBe(4);
    });
  });
});
