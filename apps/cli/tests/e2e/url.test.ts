import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { pngBytes, signedInHarness, type CliHarness } from './helpers.ts';

const WEB = 'https://tools.example.test';

describe('url commands', () => {
  let h: CliHarness;
  let user: TestUser;
  let projectId: string;
  let deckId: string;
  let cardId: string;
  let componentId: string;
  let artworkId: string;
  let folderId: string;
  let assetId: string;

  async function json<T>(res: Response | { json(): Promise<T>; status: number }): Promise<T> {
    return (await res.json()) as T;
  }

  function upload(query: Record<string, string>, seed: number) {
    const params = new URLSearchParams({ project_id: projectId, ...query });
    return user.api.postBytes(`/api/files/upload?${params}`, pngBytes(seed) as unknown as BodyInit);
  }

  beforeAll(async () => {
    ({ h, user } = await signedInHarness('cli-url'));
    projectId = (
      await json<{ id: string }>(await user.api.post('/api/projects', { name: 'Linked' }))
    ).id;
    deckId = (
      await json<{ id: string }>(
        await user.api.post('/api/decks', {
          project_id: projectId,
          name: 'Heroes',
          card_width_mm: 63,
          card_height_mm: 88,
        })
      )
    ).id;
    cardId = (await json<{ id: string }>(await upload({ filename: 'ace.png', deck_id: deckId }, 1)))
      .id;
    componentId = (
      await json<{ id: string }>(
        await user.api.post('/api/components', { project_id: projectId, kind: 'box', name: 'Box' })
      )
    ).id;
    artworkId = (
      await json<{ id: string }>(
        await upload({ filename: 'wrap.png', component_id: componentId, role: 'artwork' }, 2)
      )
    ).id;
    folderId = (
      await json<{ id: string }>(
        await user.api.post('/api/files/folders', { project_id: projectId, name: 'Art' })
      )
    ).id;
    assetId = (
      await json<{ id: string }>(await upload({ filename: 'cover.png', folder_id: folderId }, 3))
    ).id;
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  async function url(args: string[]): Promise<string> {
    const res = await h.runCli(['url', ...args, '--project', 'Linked'], {
      env: { THREEPEAKS_WEB_URL: `${WEB}/` },
    });
    expect(res.stderr).toBe('');
    expect(res.exitCode).toBe(0);
    return res.stdout;
  }

  it('prints the bare link, one line, against the configured web base', async () => {
    expect(await url(['members'])).toBe(`${WEB}/projects/${projectId}/members\n`);
  });

  it('links a project by positional name', async () => {
    const res = await h.runCli(['url', 'project', 'Linked'], {
      env: { THREEPEAKS_WEB_URL: WEB },
    });
    expect(res.stdout).toBe(`${WEB}/projects/${projectId}\n`);
  });

  it('links decks, a deck, its history and the print screen', async () => {
    expect(await url(['decks'])).toBe(`${WEB}/projects/${projectId}/decks\n`);
    expect(await url(['deck', 'Heroes'])).toBe(`${WEB}/projects/${projectId}/decks/${deckId}\n`);
    expect(await url(['deck', 'Heroes', '--history'])).toBe(
      `${WEB}/projects/${projectId}/decks/${deckId}/history\n`
    );
    expect(await url(['print', '--deck', 'Heroes'])).toBe(
      `${WEB}/projects/${projectId}/print?deck=${deckId}\n`
    );
  });

  it('links a component, a section, the scene and the trash', async () => {
    expect(await url(['component', 'Box'])).toBe(
      `${WEB}/projects/${projectId}/components/${componentId}\n`
    );
    expect(await url(['section', 'box'])).toBe(`${WEB}/projects/${projectId}/components/box\n`);
    expect(await url(['scene'])).toBe(`${WEB}/projects/${projectId}/scene\n`);
    expect(await url(['trash'])).toBe(`${WEB}/projects/${projectId}/deleted\n`);
  });

  it('links Assets and a folder in it by path', async () => {
    expect(await url(['folder'])).toBe(`${WEB}/projects/${projectId}/assets\n`);
    expect(await url(['folder', 'art'])).toBe(
      `${WEB}/projects/${projectId}/assets?folder=${folderId}\n`
    );
  });

  it('links a file by path, by deck, by component and by id', async () => {
    expect(await url(['file', 'Art/cover.png'])).toBe(
      `${WEB}/projects/${projectId}/files/${assetId}/versions\n`
    );
    expect(await url(['file', 'ace.png', '--deck', 'Heroes'])).toBe(
      `${WEB}/projects/${projectId}/files/${cardId}/versions\n`
    );
    expect(await url(['file', 'artwork', '--component', 'Box'])).toBe(
      `${WEB}/projects/${projectId}/files/${artworkId}/versions\n`
    );
    const byId = await h.runCli(['url', 'file', cardId, '--3d', '--json'], {
      env: { THREEPEAKS_WEB_URL: WEB },
    });
    expect(byId.json<{ url: string }>().url).toBe(
      `${WEB}/projects/${projectId}/files/${cardId}/3d`
    );
  });

  it('refuses --3d for a file that is not a deck card', async () => {
    const res = await h.runCli(['url', 'file', 'Art/cover.png', '--3d', '--project', 'Linked']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('url component');
  });

  it('refuses a web base that cannot carry a path', async () => {
    const res = await h.runCli(['url', 'scene', '--project', 'Linked'], {
      env: { THREEPEAKS_WEB_URL: 'https://tools.example.test/?x=1' },
    });
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('Invalid web URL');
  });

  it('a missing folder is exit 4', async () => {
    const res = await h.runCli(['url', 'folder', 'Nope', '--project', 'Linked']);
    expect(res.exitCode).toBe(4);
  });
});
