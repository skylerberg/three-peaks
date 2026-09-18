import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { components } from '@three-peaks/shared/api';
import { deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { signedInHarness, type CliHarness } from './helpers.ts';

type DeletedListing = components['schemas']['DeletedListing'];

describe('trash commands', () => {
  let h: CliHarness;
  let user: TestUser;
  let projectId: string;
  let local: string;

  function cli(argv: string[]) {
    return h.runCli([...argv, '--project', projectId]);
  }

  async function upload(name: string, contents: string, to?: string): Promise<void> {
    const path = join(local, name);
    await writeFile(path, contents);
    const res = await cli(['upload', path, ...(to === undefined ? [] : ['--to', to])]);
    expect(res.exitCode).toBe(0);
  }

  async function listed(): Promise<DeletedListing['entries']> {
    return (await cli(['trash', 'list', '--json'])).json<DeletedListing>().entries;
  }

  beforeAll(async () => {
    ({ h, user } = await signedInHarness('cli-trash'));
    projectId = (await (await user.api.post('/api/projects', { name: 'Trash CLI' })).json()).id;
    local = join(h.workDir, 'trash');
    await mkdir(local, { recursive: true });
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  it('says so when nothing has been deleted', async () => {
    const res = await cli(['trash', 'list']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('Nothing deleted in Trash CLI\n');
  });

  it('lists every kind, with where each came from, and filters by kind', async () => {
    await cli(['mkdir', '-p', 'Art/Old']);
    await upload('a.txt', 'art a', 'Art');
    await upload('a.txt', 'old a', 'Art/Old');
    const deck = await (
      await user.api.post('/api/decks', {
        project_id: projectId,
        name: 'Starter deck',
        card_width_mm: 63,
        card_height_mm: 88,
      })
    ).json();
    const component = await (
      await user.api.post('/api/components', {
        project_id: projectId,
        kind: 'box',
        name: 'Game box',
      })
    ).json();

    expect((await cli(['file', 'delete', 'Art/a.txt'])).exitCode).toBe(0);
    expect((await cli(['file', 'delete', 'Art/Old/a.txt'])).exitCode).toBe(0);
    expect((await user.api.delete(`/api/decks/${deck.id}`)).status).toBe(204);
    expect((await user.api.delete(`/api/components/${component.id}`)).status).toBe(204);

    const entries = await listed();
    expect(entries.map((e) => [e.kind, e.path, e.name]).sort()).toEqual([
      ['component', '', 'Game box'],
      ['deck', '', 'Starter deck'],
      ['file', 'Art', 'a.txt'],
      ['file', 'Art/Old', 'a.txt'],
    ]);

    const human = await cli(['trash', 'list']);
    expect(human.stdout).toMatch(/file\s+Art\/Old\/a\.txt/);
    expect(human.stdout).toMatch(/deck\s+Starter deck/);

    const decks = await cli(['trash', 'list', '--kind', 'deck', '--json']);
    expect(decks.json<DeletedListing>().entries.map((e) => e.name)).toEqual(['Starter deck']);

    expect((await cli(['trash', 'list', '--kind', 'card'])).exitCode).toBe(2);
  });

  it('tells two tombstones of one name apart by their path', async () => {
    const ambiguous = await cli(['trash', 'restore', 'a.txt']);
    expect(ambiguous.exitCode).toBe(2);
    expect(ambiguous.stderr).toContain('Ambiguous deleted entry "a.txt"');

    const res = await cli(['trash', 'restore', 'Art/Old/a.txt']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Restored file "Art/Old/a.txt"');
    const bytes = await cli(['download', 'Art/Old/a.txt', '-o', '-']);
    expect(bytes.stdout).toBe('old a');
  });

  it('restores a deck under a new name, and a component under its own', async () => {
    const renamed = await cli(['trash', 'restore', 'Starter deck', '--name', 'Second deck']);
    expect(renamed.exitCode, renamed.stderr).toBe(0);
    expect((await cli(['trash', 'restore', 'Game box', '--json'])).exitCode).toBe(0);

    const decks = await (await user.api.get(`/api/decks?project_id=${projectId}`)).json();
    expect(decks.decks.map((d: { name: string }) => d.name)).toEqual(['Second deck']);
    const components = await (await user.api.get(`/api/components?project_id=${projectId}`)).json();
    expect(components.components.map((c: { name: string }) => c.name)).toEqual(['Game box']);
  });

  it('shows what blocks a restore, and the restore refuses until that is back', async () => {
    await upload('inner.txt', 'inner', 'Art/Old');
    expect((await cli(['file', 'delete', 'Art/Old/inner.txt'])).exitCode).toBe(0);
    expect((await cli(['folder', 'delete', 'Art/Old'])).exitCode).toBe(0);

    const human = await cli(['trash', 'list']);
    expect(human.stdout).toMatch(/Art\/Old\/inner\.txt.*Old/);
    expect(human.stdout).toContain('restore that first');

    const refused = await cli(['trash', 'restore', 'Art/Old/inner.txt']);
    expect(refused.exitCode).toBe(5);

    expect((await cli(['trash', 'restore', 'Art/Old'])).exitCode).toBe(0);
    expect((await cli(['trash', 'restore', 'Art/Old/inner.txt'])).exitCode).toBe(0);
  });

  it('renames a file on the way back when its name has been taken', async () => {
    await upload('a.txt', 'art a, again', 'Art');
    const clash = await cli(['trash', 'restore', 'Art/a.txt']);
    expect(clash.exitCode).toBe(5);

    const res = await cli(['trash', 'restore', 'Art/a.txt', '--name', 'a-first.txt']);
    expect(res.exitCode).toBe(0);
    const bytes = await cli(['download', 'Art/a-first.txt', '-o', '-']);
    expect(bytes.stdout).toBe('art a');
  });

  it('purges only once confirmed, and the entry is gone for good', async () => {
    expect((await user.api.delete(`/api/components/${await componentId()}`)).status).toBe(204);

    const unconfirmed = await cli(['trash', 'purge', 'Game box', '--no-input']);
    expect(unconfirmed.exitCode).toBe(2);
    expect(unconfirmed.stderr).toContain('pass --force');
    expect((await listed()).map((e) => e.name)).toContain('Game box');

    const purged = await cli(['trash', 'purge', 'Game box', '--force']);
    expect(purged.exitCode).toBe(0);
    expect(purged.stdout).toContain('Permanently deleted component "Game box"');
    expect((await listed()).map((e) => e.name)).not.toContain('Game box');
  });

  async function componentId(): Promise<string> {
    const { components } = await (
      await user.api.get(`/api/components?project_id=${projectId}`)
    ).json();
    return components[0].id;
  }
});
