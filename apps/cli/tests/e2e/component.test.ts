import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { COMPONENT_KINDS, DEFAULT_BOX_SETTINGS, DEFAULT_WOOD_SETTINGS } from '@three-peaks/shared';
import type { components } from '@three-peaks/shared/api';
import { createUser, deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import {
  API_URL,
  createCliHarness,
  signedInHarness,
  pngBytes,
  type CliHarness,
} from './helpers.ts';
import { EXIT } from '../../src/errors.ts';

type Component = components['schemas']['Component'];

const CUT_SHEET =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M10 10 L40 10 L40 40 L10 40 Z"/><path d="M60 60 L90 60 L90 90 L60 90 Z"/></svg>';

describe('component commands', () => {
  let h: CliHarness;
  let user: TestUser;
  let projectId: string;
  let files: string;

  // Every call names its project, so no test depends on a configured default.
  function cli(args: string[], options?: Parameters<CliHarness['runCli']>[1]) {
    return h.runCli([...args, '--project', projectId], options);
  }

  async function fixture(name: string, bytes: Buffer | string): Promise<string> {
    const path = join(files, name);
    await writeFile(path, bytes);
    return path;
  }

  async function create(name: string, kind: string, extra: string[] = []): Promise<Component> {
    const res = await cli(['component', 'create', name, '--kind', kind, '--json', ...extra]);
    expect(res.exitCode, res.stderr).toBe(0);
    return res.json<Component>();
  }

  async function sectionNames(kind: string): Promise<string[]> {
    const res = await cli(['component', 'list', '--kind', kind, '--json']);
    return res.json<Component[]>().map((c) => c.name);
  }

  beforeAll(async () => {
    ({ h, user } = await signedInHarness('cli-component'));
    projectId = (await (await user.api.post('/api/projects', { name: 'Pieces' })).json()).id;
    files = join(h.workDir, 'component');
    await mkdir(files, { recursive: true });
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  it('kinds lists every kind with the files it takes, without a project', async () => {
    const res = await h.runCli(['component', 'kinds', '--json']);
    expect(res.exitCode).toBe(0);
    const kinds = res.json<{ kind: string; roles: string[] }[]>();
    expect(kinds.map((k) => k.kind)).toEqual([...COMPONENT_KINDS]);
    expect(kinds.find((k) => k.kind === 'punchboard')?.roles).toEqual(['artwork', 'cut']);

    const human = await h.runCli(['component', 'kinds']);
    expect(human.stdout).toContain('Punchboards');
  });

  describe('create', () => {
    it('starts from the studio defaults and reports what it is missing', async () => {
      const res = await cli(['component', 'create', 'Meeple', '--kind', 'wood']);
      expect(res.exitCode, res.stderr).toBe(0);
      expect(res.stdout).toContain('Created wooden piece "Meeple"');
      expect(res.stdout).toContain('Upload its artwork');

      const shown = (await cli(['component', 'show', 'Meeple', '--json'])).json<Component>();
      expect(shown.settings).toEqual(DEFAULT_WOOD_SETTINGS);
      expect(shown.missing_roles).toEqual(['artwork']);

      const listed = await cli(['component', 'list']);
      expect(listed.stdout).toContain('Wooden pieces');
      expect(listed.stdout).toMatch(/Meeple\s+artwork: missing/);
    });

    it('lays --file and then --set over the defaults', async () => {
      const settingsFile = await fixture('box.json', JSON.stringify({ depth_mm: 40, seed: 3 }));
      const made = await create('Retail box', 'box', [
        '--file',
        settingsFile,
        '--set',
        'width_mm=200',
        '--set',
        'seed=7',
      ]);
      expect(made.settings).toEqual({
        ...DEFAULT_BOX_SETTINGS,
        depth_mm: 40,
        width_mm: 200,
        seed: 7,
      });
    });

    it('reads settings from stdin', async () => {
      const piped = await cli(
        ['component', 'create', 'Quad board', '--kind', 'board', '--file', '-', '--json'],
        { stdin: '{"fold": "quadfold"}' }
      );
      expect(piped.exitCode, piped.stderr).toBe(0);
      expect(piped.json<Component>().settings).toMatchObject({ kind: 'board', fold: 'quadfold' });
    });

    it('refuses a setting the kind does not have, a bad value, and a value out of bounds', async () => {
      const unknown = await cli([
        'component',
        'create',
        'X',
        '--kind',
        'wood',
        '--set',
        'width_mm=3',
      ]);
      expect(unknown.exitCode).toBe(EXIT.usage);
      expect(unknown.stderr).toContain('No setting "width_mm" on a wood');

      const bad = await cli(['component', 'create', 'X', '--kind', 'wood', '--set', 'seed=many']);
      expect(bad.exitCode).toBe(EXIT.invalid);

      const bounds = await cli([
        'component',
        'create',
        'X',
        '--kind',
        'box',
        '--set',
        'width_mm=100000',
      ]);
      expect(bounds.exitCode).toBe(EXIT.invalid);
      expect(bounds.stderr).toContain('width_mm');
      expect(await sectionNames('box')).not.toContain('X');
    });

    it('refuses a kind that does not exist, and a name already taken', async () => {
      const kind = await cli(['component', 'create', 'X', '--kind', 'card']);
      expect(kind.exitCode).toBe(EXIT.usage);

      await create('Taken', 'wood');
      const again = await cli(['component', 'create', 'taken', '--kind', 'box']);
      expect(again.exitCode).toBe(EXIT.conflict);
    });
  });

  describe('upload and download', () => {
    it('fills an empty slot, then versions it, and says when nothing changed', async () => {
      const piece = await create('Token', 'wood');
      const first = await fixture('token.png', pngBytes(1));

      const uploaded = await cli(['component', 'upload', 'Token', first, '--json']);
      expect(uploaded.exitCode, uploaded.stderr).toBe(0);
      const body = uploaded.json<{
        outcome: string;
        role: string;
        file: { id: string; filename: string };
        missing_roles: string[];
      }>();
      expect(body).toMatchObject({ outcome: 'uploaded', role: 'artwork', missing_roles: [] });
      expect(body.file.filename).toBe('token.png');

      const same = await cli(['component', 'upload', 'Token', first]);
      expect(same.exitCode).toBe(0);
      expect(same.stdout).toContain('nothing changed');

      const second = await fixture('token-v2.png', pngBytes(2));
      const versioned = await cli(['component', 'upload', piece.id, second, '--json']);
      expect(versioned.exitCode, versioned.stderr).toBe(0);
      expect(versioned.json()).toMatchObject({
        outcome: 'versioned',
        file_id: body.file.id,
        version: { version_number: 2 },
      });

      // Still the one file, now holding both versions.
      const shown = (await cli(['component', 'show', 'Token', '--json'])).json<Component>();
      expect(shown.files.map((f) => f.file.id)).toEqual([body.file.id]);
      const versions = await (await user.api.get(`/api/files/${body.file.id}/versions`)).json();
      expect(versions.versions).toHaveLength(2);
    });

    it('refuses a role the kind does not take', async () => {
      await create('Plain piece', 'wood');
      const res = await cli([
        'component',
        'upload',
        'Plain piece',
        await fixture('sheet.svg', CUT_SHEET),
        '--role',
        'cut',
      ]);
      expect(res.exitCode).toBe(EXIT.usage);
      expect(res.stderr).toContain('A wooden piece has no cut file; it takes: artwork');
    });

    it('fills a punchboard’s missing slots in order', async () => {
      await create('Sprue', 'punchboard');
      const artwork = await cli([
        'component',
        'upload',
        'Sprue',
        await fixture('sprue.png', pngBytes(3)),
      ]);
      expect(artwork.stdout).toContain('as the artwork of punchboard "Sprue"');
      expect(artwork.stdout).toContain('Still missing: cut');

      const cut = await cli([
        'component',
        'upload',
        'Sprue',
        await fixture('sprue-cut.svg', CUT_SHEET),
      ]);
      expect(cut.exitCode, cut.stderr).toBe(0);
      expect(cut.stdout).toContain('as the cut of punchboard "Sprue"');

      const shown = await cli(['component', 'show', 'Sprue']);
      expect(shown.stdout).toMatch(/cut\s+sprue-cut\.svg/);
      expect(shown.stdout).not.toContain('missing');
    });

    it('downloads a file, refuses to overwrite one, and writes into a directory', async () => {
      await create('Crate', 'box');
      const bytes = pngBytes(4);
      await cli(['component', 'upload', 'Crate', await fixture('crate.png', bytes)]);

      const out = join(files, 'out');
      await mkdir(out, { recursive: true });
      const target = join(out, 'crate-copy.png');
      const first = await cli(['component', 'download', 'Crate', '-o', target, '--json']);
      expect(first.exitCode, first.stderr).toBe(0);
      expect(first.json()).toMatchObject({
        path: target,
        size_bytes: bytes.length,
        role: 'artwork',
      });
      expect(await readFile(target)).toEqual(bytes);

      const again = await cli(['component', 'download', 'Crate', '-o', target]);
      expect(again.exitCode).toBe(EXIT.conflict);
      const forced = await cli(['component', 'download', 'Crate', '-o', target, '--force']);
      expect(forced.exitCode).toBe(0);

      const intoDir = await cli(['component', 'download', 'Crate', '-o', out]);
      expect(intoDir.exitCode, intoDir.stderr).toBe(0);
      expect(await readFile(join(out, 'crate.png'))).toEqual(bytes);
    });

    it('downloads to stdout, and says so when there is nothing to download', async () => {
      await create('Cut board', 'punchboard');
      await cli(['component', 'upload', 'Cut board', await fixture('cb.png', pngBytes(5))]);
      await cli([
        'component',
        'upload',
        'Cut board',
        await fixture('cb.svg', CUT_SHEET),
        '--role',
        'cut',
      ]);

      const piped = await cli(['component', 'download', 'Cut board', '--role', 'cut', '-o', '-']);
      expect(piped.exitCode, piped.stderr).toBe(0);
      expect(piped.stdout).toBe(CUT_SHEET);

      await create('Bare', 'board');
      const none = await cli(['component', 'download', 'Bare']);
      expect(none.exitCode).toBe(EXIT.notFound);
      expect(none.stderr).toContain('has no artwork yet');
    });

    it('refuses to version a slot whose file is deleted, and names the way out', async () => {
      await create('Tile', 'box');
      await cli(['component', 'upload', 'Tile', await fixture('tile.png', pngBytes(6))]);
      const fileId = (await cli(['component', 'show', 'Tile', '--json'])).json<Component>().files[0]
        .file.id;
      expect((await user.api.delete(`/api/files/${fileId}`)).status).toBe(204);

      const res = await cli([
        'component',
        'upload',
        'Tile',
        await fixture('tile2.png', pngBytes(7)),
      ]);
      expect(res.exitCode).toBe(EXIT.conflict);
      expect(res.stderr).toContain(`threepeaks trash restore ${fileId}`);
      expect(res.stderr).toContain(`threepeaks trash purge ${fileId}`);

      const listed = await cli(['component', 'list', '--kind', 'box']);
      expect(listed.stdout).toMatch(/Tile\s+artwork: tile\.png \(deleted\)/);
    });
  });

  describe('settings', () => {
    it('prints them, saves a change, and skips a save that changes nothing', async () => {
      await create('Worker', 'wood');
      const shown = await cli(['component', 'settings', 'Worker']);
      expect(shown.stdout).toContain('thickness_mm = 8');
      expect(shown.stdout).not.toContain('kind');

      const saved = await cli([
        'component',
        'settings',
        'Worker',
        '--set',
        'printed=true',
        '--json',
      ]);
      expect(saved.exitCode, saved.stderr).toBe(0);
      expect(saved.json<Component>().settings).toMatchObject({ printed: true });

      const methods: string[] = [];
      const idle = await cli(['component', 'settings', 'Worker', '--set', 'printed=yes'], {
        onRequest: (request) => methods.push(request.method),
      });
      expect(idle.exitCode).toBe(0);
      expect(idle.stdout).toContain('No change');
      expect(methods).not.toContain('PATCH');

      const reset = await cli(['component', 'settings', 'Worker', '--reset', '--json']);
      expect(reset.json<Component>().settings).toEqual(DEFAULT_WOOD_SETTINGS);
    });

    it('refuses a file of settings for another kind', async () => {
      await create('Lid', 'box');
      const res = await cli(['component', 'settings', 'Lid', '--file', '-'], {
        stdin: '{"kind": "wood"}',
      });
      expect(res.exitCode).toBe(EXIT.invalid);
    });
  });

  it('rename changes the name and refuses one already taken', async () => {
    await create('Old name', 'wood');
    await create('Other name', 'wood');
    const res = await cli(['component', 'rename', 'Old name', 'New name']);
    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stdout).toContain('Renamed wooden piece "Old name" to "New name"');

    const clash = await cli(['component', 'rename', 'New name', 'other name']);
    expect(clash.exitCode).toBe(EXIT.conflict);
  });

  describe('move', () => {
    beforeAll(async () => {
      for (const name of ['Alpha', 'Bravo', 'Charlie']) await create(name, 'board');
    });

    it('moves within the section', async () => {
      const start = (await sectionNames('board')).filter((n) =>
        ['Alpha', 'Bravo', 'Charlie'].includes(n)
      );
      expect(start).toEqual(['Alpha', 'Bravo', 'Charlie']);

      const top = await cli(['component', 'move', 'Charlie', '--top']);
      expect(top.exitCode, top.stderr).toBe(0);
      expect(top.stdout).toContain('Moved board "Charlie" to #1 in Boards');
      expect((await sectionNames('board'))[0]).toBe('Charlie');

      await cli(['component', 'move', 'Charlie', '--after', 'Bravo']);
      const names = await sectionNames('board');
      expect(names.indexOf('Charlie')).toBe(names.indexOf('Bravo') + 1);

      await cli(['component', 'move', 'Alpha', '--bottom']);
      expect((await sectionNames('board')).at(-1)).toBe('Alpha');

      await cli(['component', 'move', 'Alpha', '--position', '2']);
      expect((await sectionNames('board'))[1]).toBe('Alpha');
    });

    it('writes nothing for a move that lands where it started', async () => {
      const names = await sectionNames('board');
      const methods: string[] = [];
      const res = await cli(['component', 'move', names[0], '--top'], {
        onRequest: (request) => methods.push(request.method),
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('is already #1');
      expect(methods).not.toContain('PUT');
    });

    it('refuses an anchor of another kind, and anything but one placement', async () => {
      await create('Pawn', 'wood');
      const res = await cli(['component', 'move', 'Alpha', '--before', 'Pawn']);
      expect(res.exitCode).toBe(EXIT.notFound);
      expect(res.stderr).toContain('No board matching "Pawn" in Boards');

      expect((await cli(['component', 'move', 'Alpha'])).exitCode).toBe(EXIT.usage);
      expect((await cli(['component', 'move', 'Alpha', '--top', '--bottom'])).exitCode).toBe(
        EXIT.usage
      );
    });
  });

  describe('delete and restore', () => {
    // A soft delete is undone by a restore, so only the purge asks.
    it('asks before a purge, and refuses to ask when it cannot', async () => {
      await create('Keep me', 'box');
      const refused = await cli(['component', 'delete', 'Keep me', '--purge', '--no-input']);
      expect(refused.exitCode).toBe(EXIT.usage);
      expect(refused.stderr).toContain('--force');
      expect(await sectionNames('box')).toContain('Keep me');
    });

    it('soft-deletes, still shows and edits the tombstone, and restores it', async () => {
      await create('Spare', 'box');
      await cli(['component', 'upload', 'Spare', await fixture('spare.png', pngBytes(8))]);
      const deleted = await cli(['component', 'delete', 'Spare', '--force']);
      expect(deleted.exitCode, deleted.stderr).toBe(0);
      expect(await sectionNames('box')).not.toContain('Spare');

      const shown = await cli(['component', 'show', 'Spare']);
      expect(shown.exitCode, shown.stderr).toBe(0);
      expect(shown.stdout).toContain('restore with');

      const settings = await cli(['component', 'settings', 'Spare', '--set', 'seed=9']);
      expect(settings.exitCode, settings.stderr).toBe(0);

      const rename = await cli(['component', 'rename', 'Spare', 'Nope']);
      expect(rename.exitCode).toBe(EXIT.conflict);
      expect(rename.stderr).toContain('is deleted');

      const again = await cli(['component', 'delete', 'Spare', '--force']);
      expect(again.stdout).toContain('already deleted');

      const restored = await cli(['component', 'restore', 'Spare', '--json']);
      expect(restored.exitCode, restored.stderr).toBe(0);
      expect(restored.json<Component>()).toMatchObject({ deleted_at: null, name: 'Spare' });
      expect(restored.json<Component>().settings).toMatchObject({ seed: 9 });
      expect(restored.json<Component>().files).toHaveLength(1);

      const live = await cli(['component', 'restore', 'Spare']);
      expect(live.exitCode).toBe(0);
      expect(live.stdout).toContain('is not deleted');
    });

    it('restores under a new name when the old one has been taken', async () => {
      await create('Dice tower', 'box');
      await cli(['component', 'delete', 'Dice tower', '--force']);
      await create('Dice tower', 'box');

      const clash = await cli(['component', 'restore', 'Dice tower']);
      expect(clash.exitCode).toBe(EXIT.conflict);
      expect(clash.stderr).toContain('pass --name');

      const renamed = await cli(['component', 'restore', 'Dice tower', '--name', 'Old tower']);
      expect(renamed.exitCode, renamed.stderr).toBe(0);
      const names = await sectionNames('box');
      expect(names).toContain('Dice tower');
      expect(names).toContain('Old tower');
    });

    it('purges a deleted component for good', async () => {
      const doomed = await create('Doomed', 'wood');
      await cli(['component', 'upload', 'Doomed', await fixture('doomed.png', pngBytes(9))]);
      await cli(['component', 'delete', 'Doomed', '--force']);

      const purged = await cli(['component', 'delete', 'Doomed', '--purge', '--force', '--json']);
      expect(purged.exitCode, purged.stderr).toBe(0);
      expect(purged.json()).toEqual({ deleted: doomed.id, purged: true });

      const gone = await cli(['component', 'show', doomed.id]);
      expect(gone.exitCode).toBe(EXIT.notFound);
      const entries = await (
        await user.api.get(`/api/files/deleted?project_id=${projectId}`)
      ).json();
      expect(entries.entries.map((e: { id: string }) => e.id)).not.toContain(doomed.id);
    });
  });

  it('refuses a viewer before sending anything, and the server refuses what it cannot check', async () => {
    const piece = await create('Guarded', 'wood');
    const viewer = await createUser('cli-component-viewer');
    try {
      await user.api.put(`/api/projects/${projectId}/members`, {
        email: viewer.email,
        role: 'viewer',
      });
      const viewerCli = await createCliHarness();
      await viewerCli.credentials.set(API_URL, viewer.token);

      const created = await viewerCli.runCli([
        'component',
        'create',
        'Mine',
        '--kind',
        'wood',
        '--project',
        projectId,
      ]);
      expect(created.exitCode).toBe(EXIT.forbidden);

      const renamed = await viewerCli.runCli(['component', 'rename', piece.id, 'Theirs']);
      expect(renamed.exitCode).toBe(EXIT.forbidden);

      const read = await viewerCli.runCli(['component', 'show', piece.id]);
      expect(read.exitCode).toBe(0);
    } finally {
      await deleteUser(viewer);
    }
  });
});
