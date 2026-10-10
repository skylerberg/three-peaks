import type { components } from '@three-peaks/shared/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Design } from './design.ts';

type Component = components['schemas']['Component'];

// The API client names a host that only Canva's build substitutes, so it is
// stubbed whole: what is worth holding here is which requests an import makes
// and in what order, and every one of them goes through these four.
const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const postBytes = vi.fn();

vi.mock('src/api', () => ({
  api: {
    GET: (...args: unknown[]) => get(...args),
    POST: (...args: unknown[]) => post(...args),
    PATCH: (...args: unknown[]) => patch(...args),
  },
  assertOk: (result: { data: unknown }) => result.data,
  postBytes: (...args: unknown[]) => postBytes(...args),
}));

const { BoardPlanError, describeBoardRow, importBoards, planBoards } =
  await import('./boardImport.ts');

const PROJECT = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';

// 500 mm at Canva's 96 pixels to the inch.
const HALF_METRE = (500 / 25.4) * 96;

function design(
  pages: { title?: string; size?: { width: number; height: number } | null }[],
  title: string | null = 'Colori boards'
): Design {
  return {
    title,
    pages: pages.map((page, index) => ({
      pageNumber: index + 1,
      pageId: `PB${index + 1}`,
      title: page.title ?? null,
      size: page.size === undefined ? { width: HALF_METRE, height: HALF_METRE } : page.size,
    })),
  };
}

function artworkFile(id: string, deletedAt: string | null = null) {
  return {
    role: 'artwork' as const,
    file: {
      id,
      project_id: PROJECT,
      folder_id: null,
      deck_id: null,
      component_id: 'board-1',
      component_role: 'artwork',
      filename: 'Main board.png',
      content_type: 'image/png',
      byte_size: 128,
      image_width: 1890,
      image_height: 1890,
      name_locked: false,
      uploaded_by: 'someone',
      created_at: '2026-02-01T09:00:00.000Z',
      updated_at: '2026-02-01T09:00:00.000Z',
      deleted_at: deletedAt,
    },
  };
}

function component(overrides: Partial<Component> = {}): Component {
  return {
    id: 'board-1',
    project_id: PROJECT,
    kind: 'board',
    name: 'Main board',
    position: 0,
    settings: {
      kind: 'board',
      width_mm: 500,
      height_mm: 500,
      thickness_mm: 3,
      fold: 'quadfold',
      fold_gap_mm: 2,
      edge_color: '#101010',
      seed: 7,
    },
    created_by: 'someone',
    created_at: '2026-02-01T09:00:00.000Z',
    updated_at: '2026-02-01T09:00:00.000Z',
    deleted_at: null,
    files: [artworkFile('art-1')],
    missing_roles: [],
    ...overrides,
  };
}

describe('planning boards', () => {
  it('names a board after its page and cuts it to the page’s own size', () => {
    const rows = planBoards(
      design([
        { title: 'Main board' },
        { title: 'Player mat', size: { width: 1134, height: 760 } },
      ]),
      []
    );

    expect(rows).toEqual([
      { pageNumber: 1, name: 'Main board', width_mm: 500, height_mm: 500, board: null },
      { pageNumber: 2, name: 'Player mat', width_mm: 300.04, height_mm: 201.08, board: null },
    ]);
  });

  it('names a one-page design’s board after the design when the page has no title', () => {
    expect(planBoards(design([{}], 'Harbour map'), [])[0].name).toBe('Harbour map');
  });

  it('prefers the page’s own title to the design’s', () => {
    expect(planBoards(design([{ title: 'Side A' }], 'Harbour map'), [])[0].name).toBe('Side A');
  });

  // The project's index folds case, so these are one name to the API; the
  // spacing is what an export changes without anybody meaning it to.
  it('lands a page on the board that already has its name', () => {
    const held = component();
    const [row] = planBoards(design([{ title: '  main   BOARD ' }]), [held]);

    expect(row.board).toBe(held);
    expect(row.name).toBe('main BOARD');
  });

  // The tier a deck matches on first, and the one this must not have: the copy
  // of a design keeps every page id, and a copy is how a second board starts.
  it('does not land a renamed page on the board it used to be', () => {
    const [row] = planBoards(design([{ title: 'Main board, winter' }]), [component()]);
    expect(row.board).toBeNull();
  });

  it('says so when the page is a different size from the board it lands on', () => {
    const held = component();
    const [same] = planBoards(design([{ title: 'Main board' }]), [held]);
    const [grown] = planBoards(
      design([{ title: 'Main board', size: { width: HALF_METRE * 1.2, height: HALF_METRE } }]),
      [held]
    );

    expect(describeBoardRow(same)).toBe('Updates the board, 500 × 500 mm');
    expect(describeBoardRow(grown)).toBe(
      'Updates the board, resized from 500 × 500 to 600 × 500 mm'
    );
  });

  it('describes a page nothing has its name as a new board', () => {
    const [row] = planBoards(design([{ title: 'Main board' }]), []);
    expect(describeBoardRow(row)).toBe('New board, 500 × 500 mm');
  });

  it('refuses a page nobody named, where there is more than one', () => {
    expect(() => planBoards(design([{ title: 'Main board' }, {}]), [])).toThrow(
      /Page 2 has no title/u
    );
  });

  it('refuses a one-page design with no name anywhere', () => {
    expect(() => planBoards(design([{}], null), [])).toThrow(/This design has no name/u);
  });

  it('refuses two pages that would be one board', () => {
    expect(() =>
      planBoards(design([{ title: 'Player mat' }, { title: 'player  mat' }]), [])
    ).toThrow(/Pages 1 and 2 are both named/u);
  });

  it('refuses a page with no size to cut the board to', () => {
    expect(() => planBoards(design([{ title: 'Notes', size: null }]), [])).toThrow(
      /no fixed size/u
    );
  });

  it('refuses a page outside the sizes a board may be', () => {
    expect(() =>
      planBoards(design([{ title: 'Token', size: { width: 100, height: 100 } }]), [])
    ).toThrow(/26.46 × 26.46 mm. A board is between 50 and 1200 mm/u);
  });

  // A name is unique across the project, not across the section.
  it('refuses a page named after a component that is not a board', () => {
    expect(() =>
      planBoards(design([{ title: 'Main board' }]), [component({ kind: 'box' })])
    ).toThrow(/already the name of a box/u);
  });

  // Each of them is fixed in Canva, so a run that stopped at the first would
  // cost an export per mistake.
  it('reports every problem at once', () => {
    let message = '';
    try {
      planBoards(design([{}, { title: 'Notes', size: null }, { title: 'Fine' }]), []);
    } catch (error) {
      expect(error).toBeInstanceOf(BoardPlanError);
      message = (error as Error).message;
    }
    expect(message).toMatch(/Page 1 has no title/u);
    expect(message).toMatch(/“Notes” is a page with no fixed size/u);
  });
});

describe('importing boards', () => {
  const urls = ['https://export.example/1', 'https://export.example/2'];
  const progress = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({ ok: true, blob: async () => new Blob([url]) }))
    );
    post.mockResolvedValue({ data: { id: 'board-new' } });
    patch.mockResolvedValue({ data: {} });
    postBytes.mockResolvedValue({ json: async () => ({ created: true }) });
  });

  function versionAnswers(created: boolean): void {
    postBytes.mockResolvedValue({ json: async () => ({ created }) });
  }

  function sent(call: number): { path: string; query: Record<string, string>; bytes: Blob } {
    const [path, query, bytes] = postBytes.mock.calls[call] as [string, URLSearchParams, Blob];
    return { path, query: Object.fromEntries(query), bytes };
  }

  it('creates a board at the page’s size and uploads the page into it', async () => {
    const rows = planBoards(design([{ title: 'Main board' }]), []);
    const counts = await importBoards(PROJECT, rows, urls, progress);

    expect(post).toHaveBeenCalledWith('/api/components', {
      body: {
        project_id: PROJECT,
        kind: 'board',
        name: 'Main board',
        settings: expect.objectContaining({ kind: 'board', width_mm: 500, height_mm: 500 }),
      },
    });
    expect(sent(0)).toMatchObject({
      path: '/api/files/upload',
      query: {
        project_id: PROJECT,
        filename: 'Main board.png',
        component_id: 'board-new',
        role: 'artwork',
      },
    });
    expect(counts).toEqual({ added: 1, updated: 0, unchanged: 0 });
    expect(progress).toHaveBeenLastCalledWith({ done: 1, total: 1 });
  });

  // A second file would be refused -- a component holds one artwork -- and a
  // new component would lose the settings somebody dialled in.
  it('gives a board it already has the page as a new version', async () => {
    const rows = planBoards(design([{ title: 'Main board' }]), [component()]);
    const counts = await importBoards(PROJECT, rows, urls, progress);

    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(sent(0).path).toBe('/api/files/art-1/versions');
    expect(counts).toEqual({ added: 0, updated: 1, unchanged: 0 });
  });

  it('counts a board whose bytes and size have not moved as unchanged', async () => {
    versionAnswers(false);
    const rows = planBoards(design([{ title: 'Main board' }]), [component()]);

    expect(await importBoards(PROJECT, rows, urls, progress)).toEqual({
      added: 0,
      updated: 0,
      unchanged: 1,
    });
  });

  it('resizes a board to its page and keeps the rest of its settings', async () => {
    versionAnswers(false);
    const rows = planBoards(
      design([{ title: 'Main board', size: { width: HALF_METRE * 1.2, height: HALF_METRE } }]),
      [component()]
    );
    const counts = await importBoards(PROJECT, rows, urls, progress);

    expect(patch).toHaveBeenCalledWith('/api/components/{componentId}', {
      params: { path: { componentId: 'board-1' } },
      body: {
        settings: {
          kind: 'board',
          width_mm: 600,
          height_mm: 500,
          thickness_mm: 3,
          fold: 'quadfold',
          fold_gap_mm: 2,
          edge_color: '#101010',
          seed: 7,
        },
      },
    });
    expect(counts.updated).toBe(1);
  });

  // The tombstone still holds the board's one artwork slot and refuses a new
  // version, so neither an upload beside it nor an append onto it can work.
  it('restores deleted artwork before giving it the new version', async () => {
    const held = component({ files: [artworkFile('art-1', '2026-02-04T09:00:00.000Z')] });
    const rows = planBoards(design([{ title: 'Main board' }]), [held]);
    await importBoards(PROJECT, rows, urls, progress);

    expect(post).toHaveBeenCalledWith('/api/files/{id}/restore', {
      params: { path: { id: 'art-1' } },
    });
    expect(sent(0).path).toBe('/api/files/art-1/versions');
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(postBytes.mock.invocationCallOrder[0]);
  });

  it('uploads into a board that was made and never given artwork', async () => {
    const held = component({ files: [], missing_roles: ['artwork'] });
    const rows = planBoards(design([{ title: 'Main board' }]), [held]);
    const counts = await importBoards(PROJECT, rows, urls, progress);

    expect(sent(0)).toMatchObject({
      path: '/api/files/upload',
      query: { component_id: 'board-1', role: 'artwork' },
    });
    expect(counts.updated).toBe(1);
  });

  it('puts each page’s own export on its board', async () => {
    const rows = planBoards(design([{ title: 'Main board' }, { title: 'Player mat' }]), []);
    await importBoards(PROJECT, rows, urls, progress);

    expect(await sent(0).bytes.text()).toBe(urls[0]);
    expect(await sent(1).bytes.text()).toBe(urls[1]);
    expect(sent(1).query.filename).toBe('Player mat.png');
  });

  it('stops on a page Canva will not hand over, leaving the earlier boards imported', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({ ok: url === urls[0], blob: async () => new Blob([url]) }))
    );
    const rows = planBoards(design([{ title: 'Main board' }, { title: 'Player mat' }]), []);

    await expect(importBoards(PROJECT, rows, urls, progress)).rejects.toThrow(
      /Could not download page 2/u
    );
    expect(postBytes).toHaveBeenCalledTimes(1);
  });
});
