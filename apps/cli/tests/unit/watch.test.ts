import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PING_INTERVAL_MS,
  PROJECT_REFRESH_MS,
  realtimeUrl,
  watchEvents,
  type Connect,
  type WatchHandlers,
} from '../../src/watch.ts';
import { ApiError } from '../../src/errors.ts';

interface FakeSocket {
  sent: string[];
  closed: boolean;
  open(): void;
  message(raw: string): void;
  close(code: number): void;
}

interface Harness {
  sockets: FakeSocket[];
  emitted: string[];
  notices: string[];
  listProjectIds: ReturnType<typeof vi.fn>;
  revalidateSession: ReturnType<typeof vi.fn>;
  controller: AbortController;
  promise: Promise<void>;
  last(): FakeSocket;
}

interface StartOptions {
  projectId?: string | null;
  projectIds?: string[];
  listProjectIds?: () => Promise<string[]>;
  revalidateSession?: () => Promise<boolean>;
}

function start(options: StartOptions = {}): Harness {
  const sockets: FakeSocket[] = [];
  const emitted: string[] = [];
  const notices: string[] = [];
  const controller = new AbortController();
  const listProjectIds = vi.fn(options.listProjectIds ?? (() => Promise.resolve<string[]>(['p1'])));
  const revalidateSession = vi.fn(options.revalidateSession ?? (() => Promise.resolve(true)));

  const connect: Connect = (_url: string, handlers: WatchHandlers) => {
    const socket: FakeSocket = {
      sent: [],
      closed: false,
      open: () => handlers.onOpen(),
      message: (raw: string) => handlers.onMessage(raw),
      close: (code: number) => handlers.onClose(code),
    };
    sockets.push(socket);
    return {
      send: (data: string) => socket.sent.push(data),
      // Mirrors the real adapter, which detaches its handlers before closing and
      // so never produces an onClose for a socket the state machine closed.
      close: () => {
        socket.closed = true;
      },
    };
  };

  const promise = watchEvents({
    url: 'ws://localhost:17310/ws',
    token: 'tok',
    projectId: options.projectId ?? null,
    projectIds: options.projectIds ?? ['p1'],
    listProjectIds,
    revalidateSession,
    emit: (line) => emitted.push(line),
    notify: (message) => notices.push(message),
    signal: controller.signal,
    connect,
  });

  return {
    sockets,
    emitted,
    notices,
    listProjectIds,
    revalidateSession,
    controller,
    promise,
    last: () => sockets[sockets.length - 1],
  };
}

async function stop(h: Harness): Promise<void> {
  h.controller.abort();
  await h.promise;
}

function ready(socket: FakeSocket): void {
  socket.open();
  socket.message('{"type":"ready"}');
}

const FOLDER_CREATED = '{"type":"folder_created","project_id":"p1","data":{"id":"f1"}}';

describe('realtimeUrl', () => {
  it('maps http to ws and https to wss', () => {
    expect(realtimeUrl('http://localhost:17310')).toBe('ws://localhost:17310/ws');
    expect(realtimeUrl('https://tools.threepeaksgames.com')).toBe(
      'wss://tools.threepeaksgames.com/ws'
    );
  });
});

describe('watchEvents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('authenticates on open and subscribes only once the server is ready', async () => {
    const h = start({ projectIds: ['p1', 'p2'] });
    h.last().open();
    expect(h.last().sent).toEqual(['{"type":"auth","token":"tok"}']);

    h.last().message('{"type":"ready"}');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.last().sent.slice(1)).toEqual([
      '{"type":"subscribe","project_id":"p1"}',
      '{"type":"subscribe","project_id":"p2"}',
    ]);
    expect(h.emitted).toEqual([]);
    await stop(h);
  });

  it('emits the exact frame text and swallows control frames', async () => {
    const h = start();
    ready(h.last());
    h.last().message('{"type":"pong"}');
    h.last().message(FOLDER_CREATED);
    expect(h.emitted).toEqual([FOLDER_CREATED]);
    await stop(h);
  });

  it('drops malformed frames with a notice and keeps streaming', async () => {
    const h = start();
    ready(h.last());
    h.last().message('not json');
    h.last().message('{"no":"type"}');
    h.last().message(FOLDER_CREATED);
    expect(h.emitted).toEqual([FOLDER_CREATED]);
    expect(h.notices).toHaveLength(2);
    await stop(h);
  });

  it('drops events for other projects when scoped', async () => {
    const h = start({ projectId: 'p1', projectIds: ['p1'] });
    ready(h.last());
    h.last().message('{"type":"folder_created","project_id":"p2","data":{"id":"f2"}}');
    h.last().message(FOLDER_CREATED);
    expect(h.emitted).toEqual([FOLDER_CREATED]);
    await stop(h);
  });

  it('pings on an interval once ready', async () => {
    const h = start();
    ready(h.last());
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(h.last().sent).toContain('{"type":"ping"}');
    await stop(h);
  });

  // A server that predates the pong would otherwise look dead every ninety
  // seconds and be reconnected to for ever.
  it('never declares a socket stale before the server has answered a ping', async () => {
    const h = start();
    ready(h.last());
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 10);
    expect(h.sockets).toHaveLength(1);
    expect(h.last().closed).toBe(false);
    await stop(h);
  });

  it('replaces a socket that stops answering once it has answered before', async () => {
    const h = start();
    ready(h.last());
    h.last().message('{"type":"pong"}');
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3 + 1);
    expect(h.sockets[0].closed).toBe(true);
    expect(h.notices.some((n) => n.startsWith('No reply for'))).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sockets).toHaveLength(2);
    await stop(h);
  });

  it('keeps a socket that goes on answering', async () => {
    const h = start();
    ready(h.last());
    for (let i = 0; i < 6; i += 1) {
      h.last().message('{"type":"pong"}');
      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    }
    expect(h.sockets).toHaveLength(1);
    await stop(h);
  });

  it('reconnects with exponential backoff capped at thirty seconds', async () => {
    const h = start();
    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    for (const delay of delays) {
      h.last().close(1006);
      const before = h.sockets.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.sockets).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(before + 1);
    }
    await stop(h);
  });

  it('re-lists and resubscribes on a reconnect, and says the gap closed', async () => {
    const h = start({
      projectIds: ['p1', 'p2'],
      listProjectIds: () => Promise.resolve(['p1', 'p3']),
    });
    ready(h.last());
    h.last().close(1006);
    await vi.advanceTimersByTimeAsync(1000);
    ready(h.last());
    await vi.advanceTimersByTimeAsync(0);

    expect(h.last().sent).toEqual([
      '{"type":"auth","token":"tok"}',
      '{"type":"subscribe","project_id":"p1"}',
      '{"type":"subscribe","project_id":"p2"}',
      '{"type":"subscribe","project_id":"p3"}',
      '{"type":"unsubscribe","project_id":"p2"}',
    ]);
    expect(h.notices).toContain('Connection restored');
    await stop(h);
  });

  it('follows a project shared while it runs', async () => {
    const h = start({ listProjectIds: () => Promise.resolve(['p1', 'p9']) });
    ready(h.last());
    await vi.advanceTimersByTimeAsync(PROJECT_REFRESH_MS);
    expect(h.last().sent).toContain('{"type":"subscribe","project_id":"p9"}');
    await stop(h);
  });

  it('never re-lists when scoped to one project', async () => {
    const h = start({ projectId: 'p1', projectIds: ['p1'] });
    ready(h.last());
    await vi.advanceTimersByTimeAsync(PROJECT_REFRESH_MS * 2);
    expect(h.listProjectIds).not.toHaveBeenCalled();
    await stop(h);
  });

  it('unsubscribes from a project deleted while it runs', async () => {
    const h = start({ projectIds: ['p1'] });
    ready(h.last());
    const deleted = '{"type":"project_deleted","project_id":"p1","data":{"id":"p1"}}';
    h.last().message(deleted);
    expect(h.last().sent).toContain('{"type":"unsubscribe","project_id":"p1"}');
    expect(h.emitted).toEqual([deleted]);
    await stop(h);
  });

  it('keeps the previous subscriptions when a re-list fails', async () => {
    const h = start({ listProjectIds: () => Promise.reject(new Error('offline')) });
    ready(h.last());
    await vi.advanceTimersByTimeAsync(PROJECT_REFRESH_MS);
    expect(h.notices.some((n) => n.includes('offline'))).toBe(true);
    expect(h.last().sent).not.toContain('{"type":"unsubscribe","project_id":"p1"}');
    await stop(h);
  });

  it('exits with a 401 ApiError when a 4401 close is confirmed as revoked', async () => {
    const h = start({ revalidateSession: () => Promise.resolve(false) });
    ready(h.last());
    h.last().close(4401);
    await expect(h.promise).rejects.toBeInstanceOf(ApiError);
    await expect(h.promise).rejects.toMatchObject({ status: 401 });
  });

  it('reconnects when a 4401 close leaves the credential still valid', async () => {
    const h = start();
    ready(h.last());
    h.last().close(4401);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.sockets).toHaveLength(2);
    await stop(h);
  });

  it('stops rather than taking another of the account’s connections back', async () => {
    const h = start();
    ready(h.last());
    h.last().close(4429);
    await expect(h.promise).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('resolves without connecting when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const connect = vi.fn();
    await watchEvents({
      url: 'ws://x/ws',
      token: 'tok',
      projectId: null,
      projectIds: [],
      listProjectIds: () => Promise.resolve([]),
      revalidateSession: () => Promise.resolve(true),
      emit: () => {},
      notify: () => {},
      signal: controller.signal,
      connect,
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it('closes the socket and schedules nothing once aborted', async () => {
    const h = start();
    ready(h.last());
    await stop(h);
    expect(h.last().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(PROJECT_REFRESH_MS * 2);
    expect(h.sockets).toHaveLength(1);
  });
});
