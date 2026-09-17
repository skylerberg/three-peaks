import '../api/testUtils.ts';
import { FakeWebSocket, fetchMock, jsonResponse } from '../api/testUtils.ts';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCES, TRIGGERS } from 'svelte-dnd-action';
import { DEFAULT_WOOD_SETTINGS } from '@three-peaks/shared';
import Components from './Components.svelte';
import { type ProjectComponent, projectComponents } from '../lib/components.svelte.ts';
import { realtime } from '../lib/realtime.svelte.ts';

const PROJECT = '2f1c9e5a-8b3d-4f1e-9c2a-7d6b5e4f3a21';
const OBJECT_URL = 'blob:http://localhost/thumb';

function piece(n: number, position: number): ProjectComponent {
  return {
    id: `1111111a-2222-4333-8444-00000000000${n}`,
    project_id: PROJECT,
    kind: 'wood',
    name: `piece-${n}`,
    position,
    settings: DEFAULT_WOOD_SETTINGS,
    created_by: 'someone',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: null,
    files: [],
    missing_roles: ['artwork'],
  } as unknown as ProjectComponent;
}

let listed: ProjectComponent[] = [];
let role = 'editor';

function stubApi(): void {
  fetchMock.mockImplementation(async (input) => {
    const request = typeof input === 'string' ? null : (input as Request);
    const url = request?.url ?? (input as string);
    if (url.includes('/api/components/order')) {
      return jsonResponse(200, { components: listed });
    }
    if (url.includes('/api/components')) return jsonResponse(200, { components: listed });
    if (url.includes(`/api/projects/${PROJECT}`)) {
      return jsonResponse(200, {
        id: PROJECT,
        name: 'Colori',
        description: null,
        role,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    }
    return jsonResponse(404, { error: `nothing stubbed for ${url}` });
  });
}

function zone(): HTMLElement {
  return screen.getByRole('list', { name: 'Wooden pieces, in order' });
}

function itemsAfterMoving(from: number, to: number): ProjectComponent[] {
  const items = [...projectComponents.list];
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved);
  return items;
}

function dndEvent(name: string, items: ProjectComponent[], info: Record<string, unknown>) {
  return new CustomEvent(name, { detail: { items, info: { id: items[0].id, ...info } } });
}

async function drop(from: number, to: number): Promise<ProjectComponent[]> {
  const items = itemsAfterMoving(from, to);
  await fireEvent(
    zone(),
    dndEvent('consider', items, { trigger: TRIGGERS.DRAG_STARTED, source: SOURCES.POINTER })
  );
  await fireEvent(
    zone(),
    dndEvent('finalize', items, { trigger: TRIGGERS.DROPPED_INTO_ZONE, source: SOURCES.POINTER })
  );
  return items;
}

async function orderSent(): Promise<string[] | null> {
  const call = fetchMock.mock.calls.find(([input]) => {
    const request = typeof input === 'string' ? null : (input as Request);
    return request?.method === 'PUT' && request.url.includes('/api/components/order');
  });
  if (!call) return null;
  return (await (call[0] as Request).clone().json()).component_ids;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function drawn(): string[] {
  return screen.getAllByRole('listitem').map((row) => row.getAttribute('aria-label') ?? '');
}

describe('a components section', () => {
  beforeEach(() => {
    projectComponents.reset();
    fetchMock.mockReset();
    FakeWebSocket.reset();
    listed = [piece(1, 0), piece(2, 1), piece(3, 2)];
    role = 'editor';
    stubApi();
    const statics = URL as unknown as Record<string, unknown>;
    statics.createObjectURL = vi.fn(() => OBJECT_URL);
    statics.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    realtime.stop();
    const statics = URL as unknown as Record<string, unknown>;
    delete statics.createObjectURL;
    delete statics.revokeObjectURL;
  });

  it('sends the whole section in the order a drop left it', async () => {
    render(Components, { projectId: PROJECT, kind: 'wood' });
    await waitFor(() => expect(projectComponents.list).toHaveLength(3));

    const wanted = await drop(2, 0);

    await waitFor(async () => expect(await orderSent()).toEqual(wanted.map((one) => one.id)));
  });

  it('sends nothing for a component dropped where it came from', async () => {
    render(Components, { projectId: PROJECT, kind: 'wood' });
    await waitFor(() => expect(projectComponents.list).toHaveLength(3));

    await drop(1, 1);
    // Long enough for a request to have been made, short enough that a green
    // run says so quickly.
    await wait(100);

    expect(await orderSent()).toBeNull();
  });

  // The event carries the section, so redrawing it costs no request -- which is
  // the whole reason it carries the rows rather than their ids.
  it('redraws in the order an event announces, reading nothing back', async () => {
    realtime.start('tok');
    FakeWebSocket.last().open();
    render(Components, { projectId: PROJECT, kind: 'wood' });
    await waitFor(() => expect(projectComponents.list).toHaveLength(3));
    const before = fetchMock.mock.calls.length;

    FakeWebSocket.last().receive({
      type: 'component_order_changed',
      project_id: PROJECT,
      data: {
        kind: 'wood',
        components: [piece(3, 0), piece(1, 1), piece(2, 2)],
        actor_user_id: 'someone-else',
      },
    });

    await waitFor(() => expect(drawn()[0]).toBe('piece-3'));
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  // A section knows only its own kind, and every event in the project reaches
  // it.
  it('ignores an order announced for another section', async () => {
    realtime.start('tok');
    FakeWebSocket.last().open();
    render(Components, { projectId: PROJECT, kind: 'wood' });
    await waitFor(() => expect(projectComponents.list).toHaveLength(3));

    FakeWebSocket.last().receive({
      type: 'component_order_changed',
      project_id: PROJECT,
      data: {
        kind: 'box',
        components: [piece(3, 0)],
        actor_user_id: 'someone-else',
      },
    });

    await waitFor(() => expect(drawn()).toHaveLength(3));
    expect(drawn()[0]).toBe('piece-1');
  });

  it('offers no handle to someone who cannot edit', async () => {
    role = 'viewer';
    render(Components, { projectId: PROJECT, kind: 'wood' });
    await waitFor(() => expect(projectComponents.list).toHaveLength(3));

    expect(screen.queryByLabelText('Reorder piece-1')).toBeNull();
  });
});
