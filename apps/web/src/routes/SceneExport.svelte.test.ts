import { fetchMock, jsonResponse } from '../api/testUtils.ts';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WOOD_SETTINGS } from '@three-peaks/shared';
import SceneExport from './SceneExport.svelte';
import { decks } from '../lib/decks.svelte.ts';
import { toasts } from '../lib/toasts.svelte.ts';

const PROJECT_ID = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';
const FOLDER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const STAMP = '2026-01-01T00:00:00.000Z';

function file(id: string, filename: string, deleted: string | null = null) {
  return {
    byte_size: 10,
    content_type: 'image/png',
    created_at: STAMP,
    deleted_at: deleted,
    filename,
    folder_id: null,
    id,
    image_height: 400,
    image_width: 300,
    name_locked: false,
    project_id: PROJECT_ID,
    updated_at: STAMP,
    uploaded_by: 'someone',
  };
}

const DECK = {
  back_file_id: null,
  card_count: 2,
  card_height_mm: 88,
  card_width_mm: 63,
  created_at: STAMP,
  created_by: 'someone',
  id: '3c7f1b2e-9a4d-4c6b-8e1f-2a3b4c5d6e7f',
  name: 'Villagers',
  project_id: PROJECT_ID,
  total_copies: 5,
  updated_at: STAMP,
};

const BAKER = file('11111111-1111-4111-8111-111111111111', 'baker.png');
const SMITH = file('22222222-2222-4222-8222-222222222222', 'smith.png');
const GONE = file('33333333-3333-4333-8333-333333333333', 'gone.png', STAMP);
// In the deck, and the deck holds none of it.
const SPARE = file('88888888-8888-4888-8888-888888888888', 'spare.png');

const CARDS = [
  { file: BAKER, file_id: BAKER.id, position: 0, quantity: 3 },
  { file: SMITH, file_id: SMITH.id, position: 1, quantity: 2 },
  { file: GONE, file_id: GONE.id, position: 2, quantity: 4 },
  { file: SPARE, file_id: SPARE.id, position: 3, quantity: 0 },
];

const FOLDER = {
  created_at: STAMP,
  id: FOLDER_ID,
  name: 'Tokens',
  parent_id: null,
  project_id: PROJECT_ID,
  updated_at: STAMP,
};

function component(id: string, name: string, kind: string, files: ReturnType<typeof file>[]) {
  return {
    id,
    project_id: PROJECT_ID,
    kind,
    name,
    settings: { ...DEFAULT_WOOD_SETTINGS, kind } as never,
    created_by: 'someone',
    created_at: STAMP,
    updated_at: STAMP,
    deleted_at: null,
    files: files.map((row) => ({ role: 'artwork' as const, file: row })),
    missing_roles: files.length > 0 ? [] : (['artwork'] as const),
    tokens: [],
  };
}

const MEEPLE = component('66666666-6666-4666-8666-666666666666', 'Meeple', 'wood', [
  file('44444444-4444-4444-8444-444444444444', 'token.png'),
]);
// Named but not given its artwork yet, which is nothing the table can hold.
const UNREADY = component('77777777-7777-4777-8777-777777777777', 'Half a piece', 'wood', []);

function listing(folder: typeof FOLDER | null, rows: ReturnType<typeof file>[]) {
  return {
    breadcrumb: folder ? [folder] : [],
    files: rows,
    folder,
    folders: folder ? [] : [FOLDER],
    project_id: PROJECT_ID,
    storage_quota_bytes: 1000,
    storage_used_bytes: 10,
  };
}

function serve(): void {
  fetchMock.mockImplementation(async (input) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    if (url.pathname === `/api/projects/${PROJECT_ID}`) {
      return jsonResponse(200, {
        id: PROJECT_ID,
        name: 'Colori',
        description: null,
        role: 'editor',
        created_at: STAMP,
        updated_at: STAMP,
      });
    }
    if (url.pathname === '/api/decks') return jsonResponse(200, { decks: [DECK] });
    if (url.pathname === `/api/decks/${DECK.id}`) {
      return jsonResponse(200, { deck: DECK, cards: CARDS });
    }
    if (url.pathname === '/api/components') {
      return jsonResponse(200, { components: [MEEPLE, UNREADY] });
    }
    if (url.pathname === '/api/files/directory') {
      return jsonResponse(
        200,
        listing(null, [file('55555555-5555-4555-8555-555555555555', 'board.png')])
      );
    }
    if (url.pathname.startsWith('/api/models/')) {
      return jsonResponse(500, { error: 'Settings are unreadable' });
    }
    return jsonResponse(404, { error: `unrouted ${url.pathname}` });
  });
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function readout(): string {
  const text = screen.getByText(/on the table/, { selector: 'p' }).textContent ?? '';
  return text.replace(/\s+/g, ' ').trim();
}

function asked(prefix: string): string[] {
  return fetchMock.mock.calls
    .map(
      ([input]) =>
        // A base, because a thumbnail fetches its bytes with a relative path
        // and URL will not parse one on its own.
        new URL(typeof input === 'string' ? input : (input as Request).url, 'http://localhost')
          .pathname
    )
    .filter((path) => path.startsWith(prefix));
}

describe('Scene export screen', () => {
  beforeEach(() => {
    decks.reset();
    toasts.clear();
    fetchMock.mockReset();
    serve();
  });

  it('has nothing to export until something is picked', async () => {
    render(SceneExport, { projectId: PROJECT_ID });
    await settle();

    expect(readout()).toMatch(/0 pieces on the table/);
    expect(screen.getByRole('button', { name: 'Export bundle' })).toBeDisabled();
  });

  // A deck goes on the table as the stack it really is: a card whose artwork is
  // in the bin has no bytes to build from, and one the deck holds no copies of
  // is no piece of card.
  it('counts a deck by its copies, skipping a deleted image and a zeroed card', async () => {
    render(SceneExport, { projectId: PROJECT_ID });
    await settle();

    await fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await settle();

    expect(readout()).toMatch(/5 pieces on the table/);
    expect(screen.getByText('2 cards')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export bundle' })).toBeEnabled();
  });

  // Components are picked by name out of their sections; there is no folder to
  // walk into, which is the whole of what the sections did away with.
  it('picks a component by name and counts it', async () => {
    render(SceneExport, { projectId: PROJECT_ID });
    await settle();

    await fireEvent.click(screen.getByRole('checkbox', { name: 'Meeple' }));
    await settle();

    expect(screen.getByRole('checkbox', { name: 'Meeple' })).toBeChecked();
    expect(readout()).toMatch(/1 piece on the table/);
  });

  // A component still waiting for its artwork has nothing to build from, so
  // offering it would only be a tick that fails at export.
  it('leaves out a component that has no artwork yet', async () => {
    render(SceneExport, { projectId: PROJECT_ID });
    await settle();

    expect(screen.queryByRole('checkbox', { name: 'Half a piece' })).not.toBeInTheDocument();
  });

  it('offers the templates the exporter itself knows about', async () => {
    render(SceneExport, { projectId: PROJECT_ID });
    await settle();

    const shot = screen.getByRole('combobox', { name: 'Shot' });
    expect([...shot.querySelectorAll('option')].length).toBeGreaterThan(1);
    expect(shot).toHaveValue('turntable');

    await fireEvent.change(shot, { target: { value: 'orbit' } });
    await settle();

    expect(screen.getByText(/camera circles the table/)).toBeInTheDocument();
  });

  it('adds a library piece at its own default size', async () => {
    render(SceneExport, { projectId: PROJECT_ID });
    await settle();

    await fireEvent.change(screen.getByRole('combobox', { name: 'Piece' }), {
      target: { value: 'meeple' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Add piece' }));
    await settle();

    expect(readout()).toMatch(/1 piece on the table/);
    expect(screen.getByRole('spinbutton', { name: 'Meeple size in millimetres' })).toHaveValue(16);
  });

  // Every component is built from the dial-in the studio already holds, and the
  // only place those are read is here.
  it('reads each chosen image’s settings, and none for a card nothing will build', async () => {
    render(SceneExport, { projectId: PROJECT_ID });
    await settle();

    await fireEvent.click(screen.getAllByRole('checkbox')[0]);
    await fireEvent.click(screen.getByRole('button', { name: 'Export bundle' }));
    await settle();

    expect(asked('/api/models/')).toEqual([`/api/models/${BAKER.id}`, `/api/models/${SMITH.id}`]);
    expect(toasts.toasts[0].message).toBe('Settings are unreadable');
  });
});
