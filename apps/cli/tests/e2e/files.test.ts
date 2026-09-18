import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { components } from '@three-peaks/shared/api';
import { deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { pngBytes, signedInHarness, type CliHarness } from './helpers.ts';

type DirectoryListing = components['schemas']['DirectoryListing'];
type FileRow = components['schemas']['File'];
type Folder = components['schemas']['Folder'];
type FileVersionList = components['schemas']['FileVersionList'];
type FileVersionResult = components['schemas']['FileVersionResult'];

interface UploadOutcome {
  path: string;
  outcome: 'uploaded' | 'versioned' | 'unchanged';
  file_id: string;
  filename: string;
  file?: FileRow;
  version?: FileVersionResult['version'];
}

describe('Assets commands', () => {
  let h: CliHarness;
  let user: TestUser;
  let projectId: string;
  let local: string;

  async function localFile(name: string, contents: string | Buffer): Promise<string> {
    const path = join(local, name);
    await writeFile(path, contents);
    return path;
  }

  function cli(argv: string[], options?: Parameters<CliHarness['runCli']>[1]) {
    return h.runCli([...argv, '--project', projectId], options);
  }

  beforeAll(async () => {
    ({ h, user } = await signedInHarness('cli-files'));
    projectId = (await (await user.api.post('/api/projects', { name: 'Files CLI' })).json()).id;
    local = join(h.workDir, 'files');
    await mkdir(local, { recursive: true });
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  describe('mkdir', () => {
    it('refuses a missing parent unless --parents is given', async () => {
      const refused = await cli(['mkdir', 'Art/Cards']);
      expect(refused.exitCode).toBe(4);
      expect(refused.stderr).toContain('No folder Assets/Art; pass --parents to create it');

      const made = await cli(['mkdir', '-p', 'Art/Cards', '--json']);
      expect(made.exitCode).toBe(0);
      expect(made.json<Folder>().name).toBe('Cards');

      const listing = await cli(['ls', 'Art', '--json']);
      expect(listing.json<DirectoryListing>().folders.map((f) => f.name)).toEqual(['Cards']);
    });

    it('treats an existing folder as a conflict, and as done under --parents', async () => {
      const again = await cli(['mkdir', 'art']);
      expect(again.exitCode).toBe(5);
      expect(again.stderr).toContain('Assets/art already exists');

      const accepted = await cli(['mkdir', '-p', 'art']);
      expect(accepted.exitCode).toBe(0);
      expect(accepted.stdout).toContain('already exists');
    });
  });

  describe('upload and ls', () => {
    it('uploads each file into the folder named by --to and lists them', async () => {
      const first = await localFile('rules.txt', 'How to play');
      const second = await localFile('cover.png', pngBytes(1));
      const res = await cli(['upload', first, second, '--to', 'Art/Cards']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Uploaded rules.txt to Assets/Art/Cards');
      expect(res.stdout).toContain('Uploaded cover.png to Assets/Art/Cards');

      const human = await cli(['ls', 'Art/Cards']);
      expect(human.stdout).toMatch(/^Assets\/Art\/Cards\n/);
      expect(human.stdout).toMatch(/cover\.png\s+\S+ B\s+image\/png/);
      expect(human.stdout).toContain('rules.txt');
      expect(human.stdout).toMatch(/used by Files CLI\n$/);

      const root = await cli(['ls']);
      expect(root.stdout).toMatch(/Art\/\s+folder/);
    });

    it('passes over a name that is taken, uploads the rest and names --replace', async () => {
      const taken = await localFile('rules.txt', 'rules, again');
      const fresh = await localFile('notes.txt', 'fresh');
      const res = await cli(['upload', taken, fresh, '--to', 'Art/Cards']);
      expect(res.exitCode).toBe(5);
      expect(res.stdout).toContain('Uploaded notes.txt');
      expect(res.stderr).toContain('pass --replace to add it as a new version instead');
      expect(res.stderr).toContain('1 of 2 uploads failed');

      const listing = (await cli(['ls', 'Art/Cards', '--json'])).json<DirectoryListing>();
      expect(listing.files.map((f) => f.filename).sort()).toEqual([
        'cover.png',
        'notes.txt',
        'rules.txt',
      ]);
    });

    it('adds a version under --replace, and says so when the bytes are unchanged', async () => {
      const newer = await localFile('rules.txt', 'Rules, second edition');
      const versioned = await cli(['upload', newer, '--to', 'Art/Cards', '--replace', '--json']);
      expect(versioned.exitCode).toBe(0);
      const [result] = versioned.json<UploadOutcome[]>();
      expect(result.outcome).toBe('versioned');
      expect(result.version?.version_number).toBe(2);

      const again = await cli(['upload', newer, '--to', 'Art/Cards', '--replace']);
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toContain('Unchanged rules.txt: identical to version 2');
    });

    it('checks every local path before sending anything', async () => {
      const real = await localFile('never-sent.txt', 'x');
      const res = await cli(['upload', real, join(local, 'missing.txt')]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('missing.txt');

      const root = (await cli(['ls', '--json'])).json<DirectoryListing>();
      expect(root.files.map((f) => f.filename)).not.toContain('never-sent.txt');
    });
  });

  describe('download', () => {
    it('writes the current bytes into a directory under the file’s own name', async () => {
      const outDir = join(h.workDir, 'downloads');
      await mkdir(outDir, { recursive: true });
      const res = await cli(['download', 'Art/Cards/rules.txt', '-o', outDir]);
      expect(res.exitCode).toBe(0);
      expect(await readFile(join(outDir, 'rules.txt'), 'utf8')).toBe('Rules, second edition');

      const refused = await cli(['download', 'Art/Cards/rules.txt', '-o', outDir]);
      expect(refused.exitCode).toBe(5);
      expect(refused.stderr).toContain('pass --force to overwrite it');

      const forced = await cli(['download', 'Art/Cards/rules.txt', '-o', outDir, '--force']);
      expect(forced.exitCode).toBe(0);
    });

    it('fetches an older version under a name that keeps its extension', async () => {
      const outDir = join(h.workDir, 'versions');
      await mkdir(outDir, { recursive: true });
      const res = await cli([
        'download',
        'art/cards/RULES.TXT',
        '--version',
        '1',
        '-o',
        outDir,
        '--json',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.json<{ path: string; version: number }>()).toMatchObject({
        path: join(outDir, 'rules.v1.txt'),
        version: 1,
      });
      expect(await readFile(join(outDir, 'rules.v1.txt'), 'utf8')).toBe('How to play');
    });

    it('streams to stdout with -o - and prints nothing else there', async () => {
      const res = await cli(['download', 'Art/Cards/rules.txt', '-o', '-']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('Rules, second edition');
    });

    it('refuses a version number that is not one', async () => {
      const res = await cli(['download', 'Art/Cards/rules.txt', '--version', '0', '-o', '-']);
      expect(res.exitCode).toBe(2);
    });
  });

  describe('file', () => {
    it('shows where a file lives and which version is current', async () => {
      const res = await cli(['file', 'show', 'Art/Cards/rules.txt']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/home\s+Assets\/Art\/Cards/);
      expect(res.stdout).toMatch(/version\s+2 of 2/);

      const json = (await cli(['file', 'show', 'Art/Cards/cover.png', '--json'])).json<FileRow>();
      expect(json).toMatchObject({ filename: 'cover.png', content_type: 'image/png' });
    });

    it('lists versions newest first, pushes a new one and reverts to an old one', async () => {
      const listed = await cli(['file', 'versions', 'Art/Cards/rules.txt', '--json']);
      expect(
        listed.json<FileVersionList>().versions.map((v) => [v.version_number, v.is_current])
      ).toEqual([
        [2, true],
        [1, false],
      ]);

      const third = await localFile('third.txt', 'Rules, third edition');
      const pushed = await cli(['file', 'push', 'Art/Cards/rules.txt', third]);
      expect(pushed.exitCode).toBe(0);
      expect(pushed.stdout).toContain('rules.txt is now version 3');

      const reverted = await cli(['file', 'revert', 'Art/Cards/rules.txt', '1']);
      expect(reverted.exitCode).toBe(0);
      expect(reverted.stdout).toContain('Restored version 1 of rules.txt as version 4');

      const current = await cli(['file', 'revert', 'Art/Cards/rules.txt', '4']);
      expect(current.exitCode).toBe(0);
      expect(current.stdout).toContain('Version 4 is already the current version');

      const bytes = await cli(['download', 'Art/Cards/rules.txt', '-o', '-']);
      expect(bytes.stdout).toBe('How to play');
    });

    it('renames a file and finds it by an id prefix afterwards', async () => {
      const row = (await cli(['file', 'show', 'Art/Cards/notes.txt', '--json'])).json<FileRow>();
      const res = await cli(['file', 'rename', 'Art/Cards/notes.txt', 'design-notes.txt']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Renamed notes.txt to design-notes.txt');

      const byPrefix = await cli(['file', 'show', `Art/Cards/${row.id.slice(0, 8)}`, '--json']);
      expect(byPrefix.json<FileRow>()).toMatchObject({
        filename: 'design-notes.txt',
        name_locked: true,
      });
    });

    it('moves between Assets folders keeping the name, and refuses a clash there', async () => {
      const moved = await cli(['file', 'move', 'Art/Cards/design-notes.txt', '--to', '/']);
      expect(moved.exitCode).toBe(0);
      expect(moved.stdout).toContain('Moved design-notes.txt to Assets');

      const clashing = await localFile('design-notes.txt', 'another');
      expect((await cli(['upload', clashing, '--to', 'Art'])).exitCode).toBe(0);
      const refused = await cli(['file', 'move', 'Art/design-notes.txt', '--to', '/']);
      expect(refused.exitCode).toBe(5);
    });

    it('moves an image into a deck and back out, renamed on arrival where the name is taken', async () => {
      const deckId = (
        await (
          await user.api.post('/api/decks', {
            project_id: projectId,
            name: 'Main deck',
            card_width_mm: 63,
            card_height_mm: 88,
          })
        ).json()
      ).id;

      const into = await cli(['file', 'move', 'Art/Cards/cover.png', '--to-deck', 'Main deck']);
      expect(into.exitCode).toBe(0);
      expect(into.stdout).toContain('Moved cover.png to deck "Main deck"');

      const deck = await (await user.api.get(`/api/decks/${deckId}`)).json();
      expect(deck.cards.map((c: { file: FileRow }) => c.file.filename)).toEqual(['cover.png']);

      const shown = await cli(['file', 'show', 'cover.png', '--deck', 'Main deck']);
      expect(shown.stdout).toMatch(/home\s+deck "Main deck"/);

      const outDir = join(h.workDir, 'deck-download');
      await mkdir(outDir, { recursive: true });
      const fetched = await cli(['download', 'cover.png', '--deck', 'main', '-o', outDir]);
      expect(fetched.exitCode).toBe(0);
      expect(await readFile(join(outDir, 'cover.png'))).toEqual(pngBytes(1));

      const squatter = await localFile('cover.png', pngBytes(2));
      expect((await cli(['upload', squatter, '--to', 'Art/Cards'])).exitCode).toBe(0);
      const out = await cli([
        'file',
        'move',
        'cover.png',
        '--deck',
        'Main deck',
        '--to',
        'Art/Cards',
      ]);
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toContain('renamed cover (2).png on arrival');
    });

    it('refuses a move that names no destination, or two', async () => {
      expect((await cli(['file', 'move', 'Art/Cards/rules.txt'])).exitCode).toBe(2);
      const both = await cli([
        'file',
        'move',
        'Art/Cards/rules.txt',
        '--to',
        '/',
        '--to-deck',
        'Main deck',
      ]);
      expect(both.exitCode).toBe(2);
      expect(both.stderr).toContain('exactly one of');
    });

    it('deletes softly, restores by name, and purges only when confirmed', async () => {
      const gone = await cli(['file', 'delete', 'Art/Cards/rules.txt']);
      expect(gone.exitCode).toBe(0);
      expect(gone.stdout).toContain('restore it with: threepeaks file restore');
      expect((await cli(['ls', 'Art/Cards', '--json'])).json<DirectoryListing>().files).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ filename: 'rules.txt' })])
      );

      const back = await cli(['file', 'restore', 'Art/Cards/rules.txt']);
      expect(back.exitCode).toBe(0);
      expect(back.stdout).toContain('Restored rules.txt to Assets/Art/Cards');

      const unconfirmed = await cli([
        'file',
        'delete',
        'Art/Cards/rules.txt',
        '--purge',
        '--no-input',
      ]);
      expect(unconfirmed.exitCode).toBe(2);
      expect(unconfirmed.stderr).toContain('pass --force');

      const purged = await cli(['file', 'delete', 'Art/Cards/rules.txt', '--purge', '--force']);
      expect(purged.exitCode).toBe(0);
      expect(purged.stdout).toContain('Permanently deleted rules.txt');
      const restore = await cli(['file', 'restore', 'rules.txt']);
      expect(restore.exitCode).toBe(4);
    });

    it('restores under a new name when the old one has been taken', async () => {
      const original = await localFile('board.txt', 'board one');
      await cli(['upload', original]);
      await cli(['file', 'delete', 'board.txt']);
      const replacement = await localFile('board.txt', 'board two');
      await cli(['upload', replacement]);

      const clash = await cli(['file', 'restore', 'board.txt']);
      expect(clash.exitCode).toBe(5);

      const renamed = await cli(['file', 'restore', 'board.txt', '--name', 'board-old.txt']);
      expect(renamed.exitCode).toBe(0);
      const bytes = await cli(['download', 'board-old.txt', '-o', '-']);
      expect(bytes.stdout).toBe('board one');
    });
  });

  describe('folder', () => {
    it('renames and moves a folder, carrying its contents', async () => {
      expect((await cli(['mkdir', '-p', 'Old/Inner'])).exitCode).toBe(0);
      const note = await localFile('inner.txt', 'inside');
      expect((await cli(['upload', note, '--to', 'Old/Inner'])).exitCode).toBe(0);

      const renamed = await cli(['folder', 'rename', 'Old', 'Archive']);
      expect(renamed.exitCode).toBe(0);
      expect(renamed.stdout).toContain('Renamed Old to Archive');

      const moved = await cli(['folder', 'move', 'Archive/Inner', 'Art']);
      expect(moved.exitCode).toBe(0);
      expect(moved.stdout).toContain('Moved Inner into Assets/Art');
      const bytes = await cli(['download', 'Art/Inner/inner.txt', '-o', '-']);
      expect(bytes.stdout).toBe('inside');

      const cycle = await cli(['folder', 'move', 'Art', 'Art/Inner']);
      expect(cycle.exitCode).toBe(5);

      expect((await cli(['folder', 'rename', '/', 'Root'])).exitCode).toBe(2);
    });

    it('deletes a folder softly and restores it whole', async () => {
      const gone = await cli(['folder', 'delete', 'Art/Inner']);
      expect(gone.exitCode).toBe(0);
      expect(
        (await cli(['ls', 'Art', '--json'])).json<DirectoryListing>().folders.map((f) => f.name)
      ).toEqual(['Cards']);

      const back = await cli(['folder', 'restore', 'Art/Inner']);
      expect(back.exitCode).toBe(0);
      expect(back.stdout).toContain('Restored folder Inner');
      const bytes = await cli(['download', 'Art/Inner/inner.txt', '-o', '-']);
      expect(bytes.stdout).toBe('inside');
    });

    it('purges a folder and its subtree only when confirmed', async () => {
      const unconfirmed = await cli(['folder', 'delete', 'Archive', '--purge', '--no-input']);
      expect(unconfirmed.exitCode).toBe(2);

      const purged = await cli(['folder', 'delete', 'Archive', '--purge', '--force']);
      expect(purged.exitCode).toBe(0);
      expect(
        (await cli(['ls', '--json'])).json<DirectoryListing>().folders.map((f) => f.name)
      ).not.toContain('Archive');
    });
  });
});
