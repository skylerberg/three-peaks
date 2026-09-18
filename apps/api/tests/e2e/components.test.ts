import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COMPONENT_KINDS,
  DEFAULT_PUNCHBOARD_SETTINGS,
  DEFAULT_WOOD_SETTINGS,
  defaultSettingsFor,
} from '@three-peaks/shared';
import { createUser, deleteUser, type TestUser } from '../setup/testContext.ts';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

describe('components', () => {
  let owner: TestUser;
  let viewer: TestUser;
  let stranger: TestUser;
  let projectId: string;

  beforeAll(async () => {
    [owner, viewer, stranger] = await Promise.all([
      createUser('component-owner'),
      createUser('component-viewer'),
      createUser('component-stranger'),
    ]);

    projectId = (await (await owner.api.post('/api/projects', { name: 'Components' })).json()).id;
    await owner.api.put(`/api/projects/${projectId}/members`, {
      email: viewer.email,
      role: 'viewer',
    });
  });

  afterAll(async () => {
    for (const user of [owner, viewer, stranger]) await deleteUser(user);
  });

  async function create(name: string, kind = 'wood', extra: Record<string, unknown> = {}) {
    const res = await owner.api.post('/api/components', {
      project_id: projectId,
      kind,
      name,
      ...extra,
    });
    return { status: res.status, body: await res.json() };
  }

  async function uploadInto(
    componentId: string,
    filename: string,
    role = 'artwork',
    user: TestUser = owner
  ) {
    const query = new URLSearchParams({
      project_id: projectId,
      filename,
      component_id: componentId,
      role,
    });
    const res = await user.api.postBytes(
      `/api/files/upload?${query}`,
      PNG as unknown as BodyInit,
      'image/png'
    );
    return { status: res.status, body: await res.json() };
  }

  function read(componentId: string, user: TestUser = owner) {
    return user.api.get(`/api/components/${componentId}`);
  }

  it('creates one of every kind on the studio’s own defaults', async () => {
    for (const kind of COMPONENT_KINDS) {
      const made = await create(`Default ${kind}`, kind);
      expect(made.status).toBe(201);
      expect(made.body.kind).toBe(kind);
      expect(made.body.settings).toEqual(defaultSettingsFor(kind));
    }
  });

  it('refuses settings belonging to another kind', async () => {
    const res = await create('Mismatched', 'box', { settings: DEFAULT_WOOD_SETTINGS });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/for a wood, not a box/);
  });

  // The union the studio validates against admits a card; a component's does
  // not, because a card is a member of a deck rather than a thing of its own.
  it('refuses a card, which is not a component', async () => {
    const res = await create('Not a component', 'card');
    expect(res.status).toBe(422);
  });

  it('refuses a second component with the same name in a different case', async () => {
    expect((await create('Meeple')).status).toBe(201);
    expect((await create('MEEPLE')).status).toBe(409);
  });

  it('lists one kind at a time, which is what a section asks for', async () => {
    const [, boards] = await Promise.all([
      create('Section wood', 'wood'),
      create('Section board', 'board'),
    ]);
    expect(boards.status).toBe(201);

    const res = await owner.api.get(`/api/components?project_id=${projectId}&kind=board`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.components.every((row: { kind: string }) => row.kind === 'board')).toBe(true);
    expect(body.components.map((row: { name: string }) => row.name)).toContain('Section board');
  });

  describe('the files a component holds', () => {
    it('reports what a punchboard is still waiting for', async () => {
      const made = await create('Damage tokens', 'punchboard');
      expect(made.body.missing_roles).toEqual(['artwork', 'cut']);

      expect((await uploadInto(made.body.id, 'sheet.png')).status).toBe(201);
      expect((await read(made.body.id)).status).toBe(200);
      expect((await (await read(made.body.id)).json()).missing_roles).toEqual(['cut']);

      expect((await uploadInto(made.body.id, 'cut.svg', 'cut')).status).toBe(201);
      const done = await (await read(made.body.id)).json();
      expect(done.missing_roles).toEqual([]);
      expect(done.files.map((entry: { role: string }) => entry.role).sort()).toEqual([
        'artwork',
        'cut',
      ]);
    });

    it('refuses a role the kind does not have', async () => {
      const made = await create('No cut sheet', 'wood');
      const res = await uploadInto(made.body.id, 'cut.svg', 'cut');
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/not a role a wood has/);
    });

    it('refuses a second file in the same role', async () => {
      const made = await create('One artwork only', 'box');
      expect((await uploadInto(made.body.id, 'net-a.png')).status).toBe(201);
      expect((await uploadInto(made.body.id, 'net-b.png')).status).toBe(409);
    });

    // The whole point of the sections: a component's artwork is in its own
    // screen and nowhere else.
    it('keeps its artwork out of the Assets listing', async () => {
      const made = await create('Hidden artwork', 'wood');
      const file = await uploadInto(made.body.id, 'hidden.png');
      expect(file.status).toBe(201);

      const listing = await (
        await owner.api.get(`/api/files/directory?project_id=${projectId}`)
      ).json();
      expect(listing.files.map((row: { id: string }) => row.id)).not.toContain(file.body.id);
    });
  });

  describe('deleting a component', () => {
    it('tombstones it, keeps its artwork, and restores both', async () => {
      const made = await create('Temporary piece', 'wood');
      const file = await uploadInto(made.body.id, 'temporary.png');

      expect((await owner.api.delete(`/api/components/${made.body.id}`)).status).toBe(204);

      // Readable, like a deleted file, and out of the section listing.
      const gone = await (await read(made.body.id)).json();
      expect(gone.deleted_at).not.toBeNull();
      expect(gone.files).toHaveLength(1);
      expect((await owner.api.get(`/api/files/${file.body.id}`)).status).toBe(200);

      const listed = await (
        await owner.api.get(`/api/components?project_id=${projectId}&kind=wood`)
      ).json();
      expect(listed.components.map((row: { id: string }) => row.id)).not.toContain(made.body.id);

      expect((await owner.api.post(`/api/components/${made.body.id}/restore`)).status).toBe(200);
      expect((await (await read(made.body.id)).json()).deleted_at).toBeNull();
    });

    // A tombstone above a row is not a tombstone on it, which is what makes
    // restoring the component exactly symmetric with deleting it.
    it('leaves artwork deleted on its own deleted after a restore', async () => {
      const made = await create('Half restored', 'wood');
      const file = await uploadInto(made.body.id, 'half.png');

      expect((await owner.api.delete(`/api/files/${file.body.id}`)).status).toBe(204);
      expect((await owner.api.delete(`/api/components/${made.body.id}`)).status).toBe(204);
      expect((await owner.api.post(`/api/components/${made.body.id}/restore`)).status).toBe(200);

      const back = await (await owner.api.get(`/api/files/${file.body.id}`)).json();
      expect(back.deleted_at).not.toBeNull();
    });

    it('refuses to restore artwork while the component is still deleted', async () => {
      const made = await create('Blocked artwork', 'wood');
      const file = await uploadInto(made.body.id, 'blocked.png');

      expect((await owner.api.delete(`/api/files/${file.body.id}`)).status).toBe(204);
      expect((await owner.api.delete(`/api/components/${made.body.id}`)).status).toBe(204);

      const res = await owner.api.post(`/api/files/${file.body.id}/restore`);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/Blocked artwork/);
    });

    it('purges the component and every byte its artwork held', async () => {
      const made = await create('Doomed piece', 'wood');
      const file = await uploadInto(made.body.id, 'doomed.png');

      expect((await owner.api.delete(`/api/components/${made.body.id}?purge=true`)).status).toBe(
        204
      );
      expect((await read(made.body.id)).status).toBe(404);
      expect((await owner.api.get(`/api/files/${file.body.id}`)).status).toBe(404);
    });
  });

  describe('settings', () => {
    it('saves a punchboard’s dial-in and refuses one out of bounds', async () => {
      const made = await create('Dialled in', 'punchboard');
      const settings = { ...DEFAULT_PUNCHBOARD_SETTINGS, sheet_state: 'punched' as const };

      const saved = await owner.api.patch(`/api/components/${made.body.id}`, { settings });
      expect(saved.status).toBe(200);
      expect((await saved.json()).settings.sheet_state).toBe('punched');

      const bad = await owner.api.patch(`/api/components/${made.body.id}`, {
        settings: { ...DEFAULT_PUNCHBOARD_SETTINGS, thickness_mm: 9999 },
      });
      expect(bad.status).toBe(422);
    });
  });

  describe('the order a section is drawn in', () => {
    let section: string;
    let pieces: string[];
    let box: string;

    async function make(name: string, kind = 'wood'): Promise<string> {
      const res = await owner.api.post('/api/components', { project_id: section, kind, name });
      return (await res.json()).id as string;
    }

    async function listed(kind = 'wood'): Promise<string[]> {
      const res = await owner.api.get(`/api/components?project_id=${section}&kind=${kind}`);
      return (await res.json()).components.map((one: { id: string }) => one.id);
    }

    function reorder(ids: string[], user: TestUser = owner, kind = 'wood') {
      return user.api.put('/api/components/order', {
        project_id: section,
        kind,
        component_ids: ids,
      });
    }

    beforeAll(async () => {
      section = (await (await owner.api.post('/api/projects', { name: 'Ordering' })).json()).id;
      await owner.api.put(`/api/projects/${section}/members`, {
        email: viewer.email,
        role: 'viewer',
      });
      // Named out of alphabetical order, so a listing that has quietly gone back
      // to sorting by name fails rather than agreeing by accident.
      pieces = [await make('Zebra'), await make('Ant'), await make('Mole')];
      box = await make('One box', 'box');
    });

    it('draws a new component after the ones its section already holds', async () => {
      expect(await listed()).toEqual(pieces);
    });

    it('takes the order it is given', async () => {
      const wanted = [pieces[2], pieces[0], pieces[1]];
      const res = await reorder(wanted);
      expect(res.status).toBe(200);
      expect((await res.json()).components.map((one: { id: string }) => one.id)).toEqual(wanted);
      // Read back rather than trusted: the response is built from the same
      // statement the write used, and a listing is what every other screen gets.
      expect(await listed()).toEqual(wanted);
    });

    it('keeps a component created afterwards at the end', async () => {
      const late = await make('Aardvark');
      expect((await listed()).at(-1)).toBe(late);
      await reorder((await listed()).filter((id) => id !== late));
      await owner.api.delete(`/api/components/${late}`);
    });

    it('leaves every other section alone', async () => {
      expect(await listed('box')).toEqual([box]);
    });

    it.each([
      ['one left out', (ids: string[]) => ids.slice(1)],
      ['one named twice', (ids: string[]) => [ids[0], ...ids]],
      ['a component of another kind', (ids: string[]) => [...ids, box]],
      ['an id belonging to nothing', (ids: string[]) => [...ids.slice(1), crypto.randomUUID()]],
    ])('refuses an order with %s', async (_name, mangle) => {
      const before = await listed();
      const res = await reorder(mangle(before));
      expect(res.status).toBe(422);
      expect(await listed()).toEqual(before);
    });

    // A tombstone is not in the section, so the order cannot name it -- and the
    // position it kept is what a restore brings it back to.
    it('refuses a deleted component and restores one where it was', async () => {
      const wanted = await listed();
      const gone = wanted[1];
      await owner.api.delete(`/api/components/${gone}`);

      expect((await reorder(wanted)).status).toBe(422);
      expect(await listed()).toEqual(wanted.filter((id) => id !== gone));

      await owner.api.post(`/api/components/${gone}/restore`);
      expect(await listed()).toEqual(wanted);
    });

    it('refuses a viewer with 403 and someone with no access with 404', async () => {
      const wanted = await listed();
      expect((await reorder(wanted, viewer)).status).toBe(403);
      expect((await reorder(wanted, stranger)).status).toBe(404);
    });
  });

  describe('authorization', () => {
    let componentId: string;

    beforeAll(async () => {
      componentId = (await create('Guarded piece')).body.id;
    });

    it('lets a viewer read one', async () => {
      expect((await read(componentId, viewer)).status).toBe(200);
      expect((await viewer.api.get(`/api/components?project_id=${projectId}`)).status).toBe(200);
    });

    it.each([
      [
        'renaming',
        (user: TestUser) => user.api.patch(`/api/components/${componentId}`, { name: 'No' }),
      ],
      ['deleting', (user: TestUser) => user.api.delete(`/api/components/${componentId}`)],
      ['restoring', (user: TestUser) => user.api.post(`/api/components/${componentId}/restore`)],
      [
        'uploading artwork',
        (user: TestUser) => uploadInto(componentId, 'nope.png', 'artwork', user),
      ],
    ])('refuses a viewer %s with 403', async (_name, act) => {
      expect((await act(viewer)).status).toBe(403);
    });

    // 403 would tell an outsider the component exists.
    it('sees 404, not 403, for someone with no access at all', async () => {
      expect((await read(componentId, stranger)).status).toBe(404);
      expect((await stranger.api.delete(`/api/components/${componentId}`)).status).toBe(404);
    });
  });
});
