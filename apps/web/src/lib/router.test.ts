import { describe, expect, it } from 'vitest';
import { matchRoute } from './router.svelte.ts';

const UUID = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';

describe('matchRoute', () => {
  it.each([
    ['/', 'projects'],
    ['/projects', 'projects'],
    ['/projects/', 'projects'],
    ['/account', 'account'],
    ['/login', 'login'],
    ['/signup', 'signup'],
    ['/forgot-password', 'forgot-password'],
    ['/nope', 'not-found'],
  ])('maps %s to %s', (path, name) => {
    expect(matchRoute(path).name).toBe(name);
  });

  it('reads the project id, with no folder of its own to carry', () => {
    expect(matchRoute(`/projects/${UUID}`)).toEqual({
      name: 'project',
      params: { projectId: UUID },
    });
  });

  // `?folder=` is how the explorer used to be addressed, and a bookmark still
  // says so. It reads as Assets rather than 404ing or dropping the folder.
  it('reads an old folder query on the project path as Assets', () => {
    expect(matchRoute(`/projects/${UUID}`, 'folder=abc')).toEqual({
      name: 'assets',
      params: { projectId: UUID, folderId: 'abc' },
    });
  });

  it('reads what the print screen opens on from its query', () => {
    expect(matchRoute(`/projects/${UUID}/print`)).toEqual({
      name: 'print',
      params: { projectId: UUID, deckId: null, boardId: null },
    });
    expect(matchRoute(`/projects/${UUID}/print`, 'deck=abc')).toMatchObject({
      params: { deckId: 'abc', boardId: null },
    });
    expect(matchRoute(`/projects/${UUID}/print`, 'board=def')).toMatchObject({
      params: { deckId: null, boardId: 'def' },
    });
  });

  it('reads the assets path and its folder query', () => {
    expect(matchRoute(`/projects/${UUID}/assets`, 'folder=abc')).toEqual({
      name: 'assets',
      params: { projectId: UUID, folderId: 'abc' },
    });
  });

  it('treats an empty folder query as the Assets root', () => {
    expect(matchRoute(`/projects/${UUID}/assets`, 'folder=')).toMatchObject({
      params: { folderId: null },
    });
  });

  // A uuid is one component and a word is a section; nothing else could be
  // either, which is what lets the two share a path.
  it('tells a component apart from its section by the shape of the segment', () => {
    expect(matchRoute(`/projects/${UUID}/components/${UUID}`)).toEqual({
      name: 'component',
      params: { projectId: UUID, componentId: UUID },
    });
    expect(matchRoute(`/projects/${UUID}/components/punchboard`)).toEqual({
      name: 'components',
      params: { projectId: UUID, kind: 'punchboard' },
    });
  });

  it('does not match a section that is not a component kind', () => {
    expect(matchRoute(`/projects/${UUID}/components/sprockets`).name).toBe('not-found');
  });

  it('does not match a project path whose id is not a uuid', () => {
    expect(matchRoute('/projects/not-a-uuid').name).toBe('not-found');
  });

  it('matches the members page', () => {
    expect(matchRoute(`/projects/${UUID}/members`)).toEqual({
      name: 'members',
      params: { projectId: UUID },
    });
  });

  it('matches the deleted view', () => {
    expect(matchRoute(`/projects/${UUID}/deleted`)).toEqual({
      name: 'deleted',
      params: { projectId: UUID },
    });
  });

  // The screen that read a downloaded export is gone; importing happens in the
  // Canva app. A bookmark of it must not fall through to the deck editor, which
  // its own path is a prefix of.
  it('does not match the import screen that has been removed', () => {
    const DECK = '3c7f1b2e-9a4d-4c6b-8e1f-2a3b4c5d6e7f';
    expect(matchRoute(`/projects/${UUID}/decks/${DECK}/import`).name).toBe('not-found');
  });

  describe('the deck history screens', () => {
    const DECK = '3c7f1b2e-9a4d-4c6b-8e1f-2a3b4c5d6e7f';
    const RUN = '5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a';

    it("matches a deck's history path", () => {
      expect(matchRoute(`/projects/${UUID}/decks/${DECK}/history`)).toEqual({
        name: 'deck-history',
        params: { projectId: UUID, deckId: DECK },
      });
    });

    it("matches one run's path", () => {
      expect(matchRoute(`/projects/${UUID}/decks/${DECK}/runs/${RUN}`)).toEqual({
        name: 'deck-run',
        params: { projectId: UUID, deckId: DECK, runId: RUN },
      });
    });

    it('matches the as-of path', () => {
      expect(matchRoute(`/projects/${UUID}/decks/${DECK}/runs/${RUN}/deck`)).toEqual({
        name: 'deck-as-of',
        params: { projectId: UUID, deckId: DECK, runId: RUN },
      });
    });

    // The deck editor's own path is a prefix of all three.
    it('does not fall through to the deck editor', () => {
      expect(matchRoute(`/projects/${UUID}/decks/${DECK}/history`).name).not.toBe('deck');
      expect(matchRoute(`/projects/${UUID}/decks/${DECK}/runs/${RUN}`).name).not.toBe('deck');
      expect(matchRoute(`/projects/${UUID}/decks/${DECK}/runs/${RUN}/deck`).name).not.toBe('deck');
    });

    it('is not found when a run id is not a uuid', () => {
      expect(matchRoute(`/projects/${UUID}/decks/${DECK}/runs/nope`).name).toBe('not-found');
      expect(matchRoute(`/projects/${UUID}/decks/${DECK}/runs/nope/deck`).name).toBe('not-found');
    });
  });

  describe('the 3D studio', () => {
    const FILE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

    it('reads the project and the file id', () => {
      expect(matchRoute(`/projects/${UUID}/files/${FILE}/3d`)).toEqual({
        name: 'model',
        params: { projectId: UUID, fileId: FILE },
      });
    });

    it('does not match when either id is not a uuid', () => {
      expect(matchRoute(`/projects/${UUID}/files/nope/3d`).name).toBe('not-found');
      expect(matchRoute(`/projects/nope/files/${FILE}/3d`).name).toBe('not-found');
    });

    // The project route is a prefix of this one, and it is declared first.
    it('does not fall through to the project screen', () => {
      expect(matchRoute(`/projects/${UUID}/files/${FILE}/3d`).name).not.toBe('project');
    });
  });

  describe('the version history screen', () => {
    const FILE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

    it('reads the project and the file id', () => {
      expect(matchRoute(`/projects/${UUID}/files/${FILE}/versions`)).toEqual({
        name: 'versions',
        params: { projectId: UUID, fileId: FILE },
      });
    });

    it('does not match when either id is not a uuid', () => {
      expect(matchRoute(`/projects/${UUID}/files/nope/versions`).name).toBe('not-found');
      expect(matchRoute(`/projects/nope/files/${FILE}/versions`).name).toBe('not-found');
    });
  });

  describe('the scene export screen', () => {
    it('reads the project id', () => {
      expect(matchRoute(`/projects/${UUID}/scene`)).toEqual({
        name: 'scene',
        params: { projectId: UUID },
      });
    });

    it('does not match when the id is not a uuid', () => {
      expect(matchRoute('/projects/nope/scene').name).toBe('not-found');
    });

    // The project route is a prefix of this one, and it is declared first.
    it('does not fall through to the project screen', () => {
      expect(matchRoute(`/projects/${UUID}/scene`).name).not.toBe('project');
    });
  });

  // The server builds every mailed link from these paths (see the API's
  // services/webLinks.ts). Pinning them here is what keeps a route rename from
  // quietly turning already-sent mail into a not-found page.
  describe('paths the server mails links to', () => {
    it('routes the password reset link, carrying its token', () => {
      const route = matchRoute('/reset-password', 'token=abc.def');
      expect(route).toEqual({ name: 'reset-password', params: { token: 'abc.def' } });
    });

    it('routes a reset link with no token to the same screen', () => {
      // The screen tells the visitor the link is broken; a not-found page would
      // not.
      expect(matchRoute('/reset-password').name).toBe('reset-password');
    });
  });
});
