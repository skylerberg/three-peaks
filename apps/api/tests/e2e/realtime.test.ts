import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/index.ts';
import { attachRealtime } from '../../src/services/realtime/index.ts';
import { resetConnectionsForTests } from '../../src/services/realtime/state.ts';
import { createUser, deleteUser, type TestUser } from '../setup/testContext.ts';

// Drives a real socket against a real server, because the interesting parts --
// the handshake deadline, the per-event access re-check, delivery to the right
// sockets -- are all transport behaviour that an in-process request cannot
// reach.
describe('realtime over a websocket', () => {
  let server: ReturnType<typeof serve>;
  let detach: () => void;
  let port: number;
  let owner: TestUser;
  let member: TestUser;
  let stranger: TestUser;
  let projectId: string;

  beforeAll(async () => {
    server = serve({ fetch: app.fetch, port: 0 });
    detach = attachRealtime(server as unknown as Server);
    port = (server.address() as { port: number }).port;

    [owner, member, stranger] = await Promise.all([
      createUser('rt-owner'),
      createUser('rt-member'),
      createUser('rt-stranger'),
    ]);

    projectId = (await (await owner.api.post('/api/projects', { name: 'Realtime' })).json()).id;
    await owner.api.put(`/api/projects/${projectId}/members`, {
      email: member.email,
      role: 'viewer',
    });
  });

  afterAll(async () => {
    detach();
    resetConnectionsForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const user of [owner, member, stranger]) await deleteUser(user);
  });

  function connect(token: string | null, project = projectId) {
    return new Promise<{ socket: WebSocket; events: Record<string, unknown>[] }>(
      (resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const events: Record<string, unknown>[] = [];

        socket.on('open', () => {
          if (token) socket.send(JSON.stringify({ type: 'auth', token }));
        });
        socket.on('message', (raw) => {
          const frame = JSON.parse(String(raw));
          if (frame.type === 'ready') {
            socket.send(JSON.stringify({ type: 'subscribe', project_id: project }));
            // Resolve after the subscribe has been read, so a publish that
            // follows cannot land before the room exists.
            setTimeout(() => resolve({ socket, events }), 50);
            return;
          }
          events.push(frame);
        });
        socket.on('error', reject);
        if (!token) setTimeout(() => resolve({ socket, events }), 50);
      }
    );
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

  async function upload(filename: string, into: Record<string, string> = {}): Promise<string> {
    const query = new URLSearchParams({ project_id: projectId, filename, ...into });
    const response = await owner.api.postBytes(
      `/api/files/upload?${query}`,
      PNG as unknown as BodyInit,
      'image/png'
    );
    return (await response.json()).id as string;
  }

  it('delivers a mutation to a subscribed member', async () => {
    const { socket, events } = await connect(owner.token);

    await owner.api.post('/api/files/folders', { project_id: projectId, name: 'Announced' });
    await settle();

    expect(events.map((event) => event.type)).toContain('folder_created');
    const created = events.find((event) => event.type === 'folder_created')!;
    expect(created.project_id).toBe(projectId);
    // Every event names who caused it, so a client can ignore its own echo.
    expect((created.data as { actor_user_id: string }).actor_user_id).toBe(owner.id);

    socket.close();
  });

  it('delivers to a viewer as well as the owner', async () => {
    const [a, b] = await Promise.all([connect(owner.token), connect(member.token)]);

    await owner.api.post('/api/files/folders', { project_id: projectId, name: 'Shared' });
    await settle();

    expect(a.events.some((event) => event.type === 'folder_created')).toBe(true);
    expect(b.events.some((event) => event.type === 'folder_created')).toBe(true);

    a.socket.close();
    b.socket.close();
  });

  // Subscribing is not authorization. A socket may name any project id; what
  // decides delivery is the access check run per event.
  it('delivers nothing to someone who subscribed to a project they cannot read', async () => {
    const { socket, events } = await connect(stranger.token);

    await owner.api.post('/api/files/folders', { project_id: projectId, name: 'Private' });
    await settle();

    expect(events).toEqual([]);
    socket.close();
  });

  it('stops delivering once membership is removed', async () => {
    const { socket, events } = await connect(member.token);

    await owner.api.delete(`/api/projects/${projectId}/members/${member.id}`);
    await settle();
    events.length = 0;

    await owner.api.post('/api/files/folders', { project_id: projectId, name: 'After Removal' });
    await settle();

    // The socket is still open and still subscribed; the access re-check is
    // what closes the gap, so removal takes effect without a reconnect.
    expect(events).toEqual([]);
    socket.close();

    await owner.api.put(`/api/projects/${projectId}/members`, {
      email: member.email,
      role: 'viewer',
    });
  });

  // The screen showing a file's history has to follow someone else appending to
  // it. Identical bytes create no version, so there is nothing to announce and
  // announcing anyway would send every open history screen back to the API for
  // a list that has not moved.
  it('announces a new version, and stays quiet when identical bytes create none', async () => {
    const { socket, events } = await connect(owner.token);

    const created = await owner.api.postBytes(
      `/api/files/upload?project_id=${projectId}&filename=versioned.txt`,
      'the bytes it was uploaded with' as unknown as BodyInit
    );
    expect(created.status).toBe(201);
    const fileId = (await created.json()).id;
    await settle();
    events.length = 0;

    expect(
      (await owner.api.postBytes(`/api/files/${fileId}/versions`, 'bytes that are new')).status
    ).toBe(201);
    await settle();

    const announced = events.find((event) => event.type === 'file_version_created');
    expect(announced).toBeDefined();
    expect(announced!.project_id).toBe(projectId);
    const versionData = announced!.data as {
      version: { file_id: string; version_number: number; is_current: boolean };
      file: { id: string; byte_size: number };
      storage_used_bytes: number;
      actor_user_id: string;
    };
    expect(versionData.version.file_id).toBe(fileId);
    expect(versionData.version.is_current).toBe(true);
    // Both halves and the total: the row that was added, the mirror it moved,
    // and the number the explorer's meter draws.
    expect(versionData.file.id).toBe(fileId);
    expect(versionData.storage_used_bytes).toBeGreaterThan(0);
    expect(versionData.actor_user_id).toBe(owner.id);
    events.length = 0;

    expect(
      (await owner.api.postBytes(`/api/files/${fileId}/versions`, 'bytes that are new')).status
    ).toBe(200);
    await settle();
    expect(events.map((event) => event.type)).not.toContain('file_version_created');

    socket.close();
  });

  it('closes a socket that never presents a credential', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const code = await new Promise<number>((resolve) => {
      socket.on('close', resolve);
      socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', token: 'nonsense' })));
    });
    expect(code).toBe(4401);
  });

  // The frame on the wire is the envelope the document declares. Without this
  // the two can drift and the only symptom is a client reading undefined off
  // every event.
  it('sends the envelope the published document declares', async () => {
    const { socket, events } = await connect(owner.token);

    await owner.api.post('/api/files/folders', { project_id: projectId, name: 'Wire Shape' });
    await settle();

    const event = events.find((entry) => entry.type === 'folder_created')!;
    expect(event).toBeDefined();
    expect(Object.keys(event).sort()).toEqual(['data', 'project_id', 'type']);

    const { realtimeEventsDocument } = await import('../../src/services/realtime/document.ts');
    const schemas = (
      realtimeEventsDocument().components as {
        schemas: Record<string, { properties: { data: { properties: Record<string, unknown> } } }>;
      }
    ).schemas;
    const declared = Object.keys(schemas.FolderCreatedEvent.properties.data.properties).sort();
    expect(Object.keys(event.data as object).sort()).toEqual(declared);

    socket.close();
  });

  // The point of the whole enriched payload: a client learns what changed
  // without a request back. A frame carrying only ids sends every screen
  // holding that deck to the API at once.
  it('carries the deck and its cards on a deck_updated', async () => {
    const { socket, events } = await connect(owner.token);

    const deck = await (
      await owner.api.post('/api/decks', {
        project_id: projectId,
        name: 'Carried',
        card_width_mm: 63,
        card_height_mm: 88,
      })
    ).json();

    // Into the deck: uploading it there is what makes it a card, and the event
    // has to carry the arrangement that upload changed.
    const fileId = await upload('card.png', { deck_id: deck.id });
    await owner.api.put(`/api/decks/${deck.id}/cards`, {
      cards: [{ file_id: fileId, quantity: 2 }],
    });
    await settle();

    const event = events.findLast((entry) => entry.type === 'deck_updated')!.data as {
      deck: { id: string; total_copies: number };
      cards: { file_id: string; quantity: number }[];
    };
    expect(event.deck.id).toBe(deck.id);
    expect(event.deck.total_copies).toBe(2);
    expect(event.cards).toEqual([expect.objectContaining({ file_id: fileId, quantity: 2 })]);

    socket.close();
  });

  // A deck's totals leave out the cards whose images are deleted, and the decks
  // listing hears about a deck through this event and nothing else -- a
  // file_deleted names the file, not the numbers it moved.
  describe('a deck whose card is deleted', () => {
    type DeckUpdated = {
      deck: { id: string; card_count: number; total_copies: number };
      cards: { file_id: string; file: { deleted_at: string | null } }[];
    };

    async function deckWithOneCard(name: string) {
      const deck = await (
        await owner.api.post('/api/decks', {
          project_id: projectId,
          name,
          card_width_mm: 63,
          card_height_mm: 88,
        })
      ).json();
      const fileId = await upload(`${name}.png`, { deck_id: deck.id });
      return { deckId: deck.id as string, fileId };
    }

    function lastDeckUpdate(events: Record<string, unknown>[], since: number, deckId: string) {
      return events
        .slice(since)
        .map((entry) => (entry.type === 'deck_updated' ? (entry.data as DeckUpdated) : null))
        .findLast((data) => data?.deck.id === deckId);
    }

    it('announces the deck when the card is deleted, and again when it is restored', async () => {
      const { socket, events } = await connect(owner.token);
      const { deckId, fileId } = await deckWithOneCard('Loses a card');
      await settle();

      const beforeDelete = events.length;
      await owner.api.delete(`/api/files/${fileId}`);
      await settle();
      const deleted = lastDeckUpdate(events, beforeDelete, deckId);
      expect(deleted?.deck).toMatchObject({ card_count: 0, total_copies: 0 });
      expect(deleted?.cards).toEqual([
        expect.objectContaining({
          file_id: fileId,
          file: expect.objectContaining({ deleted_at: expect.any(String) }),
        }),
      ]);

      // The card kept its place, so nothing about the arrangement moved -- the
      // totals did.
      const beforeRestore = events.length;
      await owner.api.post(`/api/files/${fileId}/restore`);
      await settle();
      expect(lastDeckUpdate(events, beforeRestore, deckId)?.deck).toMatchObject({
        card_count: 1,
        total_copies: 1,
      });

      socket.close();
    });

    // A screen holding the deck sends back every row it was given, and one the
    // cascade has already taken is refused.
    it('announces the deck without the card once its bytes are purged', async () => {
      const { socket, events } = await connect(owner.token);
      const { deckId, fileId } = await deckWithOneCard('Loses a card for good');
      await settle();

      const before = events.length;
      await owner.api.delete(`/api/files/${fileId}?purge=true`);
      await settle();
      expect(lastDeckUpdate(events, before, deckId)?.cards).toEqual([]);

      socket.close();
    });
  });

  // One fixed shape: a rename carries the cards it did not touch, so no client
  // has to test which half of the payload turned up.
  it('carries both halves even when only the deck row moved', async () => {
    const { socket, events } = await connect(owner.token);

    const deck = await (
      await owner.api.post('/api/decks', {
        project_id: projectId,
        name: 'Renamed',
        card_width_mm: 63,
        card_height_mm: 88,
      })
    ).json();
    await owner.api.patch(`/api/decks/${deck.id}`, { name: 'Renamed twice' });
    await settle();

    const event = events.findLast((entry) => entry.type === 'deck_updated')!.data as {
      deck: { name: string };
      cards: unknown[];
    };
    expect(event.deck.name).toBe('Renamed twice');
    expect(event.cards).toEqual([]);

    socket.close();
  });

  // A section's order is the one thing here that changes several rows at once,
  // so the event carries the section rather than the row that moved.
  it('carries a reordered section, and says nothing when the order did not move', async () => {
    const { socket, events } = await connect(owner.token);

    const made: string[] = [];
    for (const name of ['Rook piece', 'Pawn piece']) {
      const res = await owner.api.post('/api/components', {
        project_id: projectId,
        kind: 'wood',
        name,
      });
      made.push((await res.json()).id as string);
    }
    const wanted = [made[1], made[0]];

    await owner.api.put('/api/components/order', {
      project_id: projectId,
      kind: 'wood',
      component_ids: wanted,
    });
    await settle();

    const event = events.findLast((entry) => entry.type === 'component_order_changed')!.data as {
      kind: string;
      components: { id: string; name: string }[];
    };
    expect(event.kind).toBe('wood');
    expect(event.components.map((one) => one.id)).toEqual(wanted);
    // The rows themselves, so a section that has this open redraws without
    // going back for the names and the artwork it already holds.
    expect(event.components[0].name).toBe('Pawn piece');

    const announced = events.filter((entry) => entry.type === 'component_order_changed').length;
    await owner.api.put('/api/components/order', {
      project_id: projectId,
      kind: 'wood',
      component_ids: wanted,
    });
    await settle();
    expect(events.filter((entry) => entry.type === 'component_order_changed')).toHaveLength(
      announced
    );

    socket.close();
  });

  it('ignores a subscribe naming something that is not a uuid', async () => {
    const { socket, events } = await connect(owner.token);
    socket.send(JSON.stringify({ type: 'subscribe', project_id: '../../etc/passwd' }));
    await settle();

    await owner.api.post('/api/files/folders', { project_id: projectId, name: 'Still Fine' });
    await settle();

    // The bad room is ignored and the good one still works.
    expect(events.some((event) => event.type === 'folder_created')).toBe(true);
    socket.close();
  });
});
