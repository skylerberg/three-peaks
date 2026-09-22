import type { RealtimeCloseCode, RealtimeEvent } from '@three-peaks/shared/realtime';
import { ApiError } from './errors.ts';

// The one event this file reads a payload from. Named through the generated
// union, so a renamed type or one that stops carrying the project id fails the
// build here instead of silently leaving a deleted project subscribed.
type ProjectDeleted = Extract<RealtimeEvent, { type: 'project_deleted' }>;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// The server's own heartbeat is a protocol-level ping that undici answers
// without telling the page, so it cannot show a client that the connection is
// alive. This application-level ping can: the server answers it with a pong,
// and silence for three of them is a half-open socket that will never produce
// a close event of its own.
export const PING_INTERVAL_MS = 30_000;
const STALE_TIMEOUT_MS = PING_INTERVAL_MS * 3;
// There is no event for a project someone else shares with you, so following
// every project means asking again from time to time.
export const PROJECT_REFRESH_MS = 60_000;
const WS_OPEN = 1;

type CloseAction = 'revalidate' | 'yield';

// Keyed by the generated union, so a close code added or removed in the API
// stops this compiling rather than arriving as a code nothing routes on. Every
// code not named here is an ordinary drop and reconnects. The web client routes
// the same set its own way in apps/web/src/lib/realtime.svelte.ts.
const CLOSE_ACTIONS: Record<RealtimeCloseCode, CloseAction> = {
  4401: 'revalidate',
  4429: 'yield',
};

// A helper rather than an index, because a close code is a plain number and
// casting one into the union would bypass the exhaustiveness above at the only
// site that reads it.
function closeAction(code: number): CloseAction | null {
  return code in CLOSE_ACTIONS ? CLOSE_ACTIONS[code as RealtimeCloseCode] : null;
}

interface WatchSocket {
  send(data: string): void;
  close(): void;
}

export interface WatchHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number): void;
}

export type Connect = (url: string, handlers: WatchHandlers) => WatchSocket;

export interface WatchOptions {
  url: string;
  token: string;
  projectId: string | null;
  projectIds: string[];
  listProjectIds: () => Promise<string[]>;
  /** `false` only when the server definitively said 401; anything inconclusive is `true`. */
  revalidateSession: () => Promise<boolean>;
  emit: (line: string) => void;
  notify: (message: string) => void;
  signal: AbortSignal;
  connect?: Connect;
}

export function realtimeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/, 'ws')}/ws`;
}

const connectWebSocket: Connect = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      handlers.onMessage(event.data);
    }
  };
  ws.onclose = (event: CloseEvent) => handlers.onClose(event.code);
  ws.onerror = () => {};
  return {
    send(data: string): void {
      if (ws.readyState === WS_OPEN) {
        ws.send(data);
      }
    },
    close(): void {
      // Detaching first guarantees a socket the caller closed never calls back into it.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    },
  };
};

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deletedProjectId(data: unknown): ProjectDeleted['data']['id'] | null {
  if (typeof data !== 'object' || data === null) return null;
  const { id } = data as Partial<ProjectDeleted['data']>;
  return typeof id === 'string' ? id : null;
}

export function watchEvents(options: WatchOptions): Promise<void> {
  const connect = options.connect ?? connectWebSocket;
  const signal = options.signal;
  const tracked = new Set(options.projectIds);

  let socket: WatchSocket | null = null;
  let generation = 0;
  let stopped = false;
  let backoff = INITIAL_BACKOFF_MS;
  let hadGap = false;
  // Armed only once a pong has proved the server answers pings: a server from
  // before they were answered would otherwise look dead every ninety seconds.
  let serverPongs = false;
  let everReady = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  return new Promise<void>((resolve, reject) => {
    function clearSocketTimers(): void {
      clearTimeout(staleTimer);
      staleTimer = undefined;
      clearInterval(pingTimer);
      pingTimer = undefined;
    }

    function settle(err?: ApiError): void {
      if (!stopped) {
        stopped = true;
        clearSocketTimers();
        clearTimeout(reconnectTimer);
        clearInterval(refreshTimer);
        const dead = socket;
        socket = null;
        dead?.close();
      }
      signal.removeEventListener('abort', onAbort);
      if (err === undefined) {
        resolve();
      } else {
        reject(err);
      }
    }

    function onAbort(): void {
      settle();
    }

    function send(message: unknown): void {
      socket?.send(JSON.stringify(message));
    }

    function scheduleReconnect(): void {
      if (stopped) return;
      clearTimeout(reconnectTimer);
      const delay = backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      reconnectTimer = setTimeout(open, delay);
    }

    function armStaleTimer(): void {
      if (!serverPongs) return;
      clearTimeout(staleTimer);
      staleTimer = setTimeout(onStale, STALE_TIMEOUT_MS);
    }

    // Recovery is driven from here rather than delegated to onClose: closing a
    // half-open socket only queues a close frame, so no close event may ever
    // arrive to re-arm anything.
    function onStale(): void {
      if (stopped) return;
      options.notify(`No reply for ${STALE_TIMEOUT_MS} ms; reconnecting`);
      hadGap = true;
      const dead = socket;
      generation += 1;
      socket = null;
      clearSocketTimers();
      dead?.close();
      scheduleReconnect();
    }

    async function refreshProjects(): Promise<void> {
      if (options.projectId !== null) return;
      const gen = generation;
      let ids: string[];
      try {
        ids = await options.listProjectIds();
      } catch (err) {
        options.notify(
          `Could not refresh the project list (${errorText(err)}); keeping the previous subscriptions`
        );
        return;
      }
      if (stopped || gen !== generation) return;
      const next = new Set(ids);
      for (const id of next) {
        if (!tracked.has(id)) {
          tracked.add(id);
          send({ type: 'subscribe', project_id: id });
        }
      }
      for (const id of [...tracked]) {
        if (!next.has(id)) {
          tracked.delete(id);
          send({ type: 'unsubscribe', project_id: id });
        }
      }
    }

    async function onReady(gen: number, reconnected: boolean): Promise<void> {
      backoff = INITIAL_BACKOFF_MS;
      // Subscribed only now: frames sent before the server has checked the
      // credential are dropped, not queued.
      for (const id of tracked) {
        send({ type: 'subscribe', project_id: id });
      }
      pingTimer = setInterval(() => send({ type: 'ping' }), PING_INTERVAL_MS);
      if (reconnected) {
        await refreshProjects();
        if (stopped || gen !== generation) return;
      }
      if (hadGap) {
        options.notify('Connection restored');
        hadGap = false;
      }
    }

    function trackDeletion(type: string, data: unknown): void {
      if (options.projectId !== null || type !== 'project_deleted') return;
      const id = deletedProjectId(data);
      if (id !== null && tracked.delete(id)) {
        send({ type: 'unsubscribe', project_id: id });
      }
    }

    function onMessage(raw: string, gen: number): void {
      armStaleTimer();
      let message: { type?: unknown; project_id?: unknown; data?: unknown };
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) {
          throw new Error('frame is not a JSON object');
        }
        message = parsed;
      } catch (err) {
        options.notify(`Ignoring unreadable frame (${errorText(err)})`);
        return;
      }
      if (typeof message.type !== 'string') {
        options.notify('Ignoring frame without a type');
        return;
      }
      if (message.type === 'ready') {
        const reconnected = everReady;
        everReady = true;
        void onReady(gen, reconnected);
        return;
      }
      if (message.type === 'pong') {
        if (!serverPongs) {
          serverPongs = true;
          armStaleTimer();
        }
        return;
      }
      trackDeletion(message.type, message.data);
      if (options.projectId !== null && message.project_id !== options.projectId) {
        return;
      }
      options.emit(raw);
    }

    async function onClose(code: number, gen: number): Promise<void> {
      clearSocketTimers();
      socket = null;
      hadGap = true;
      const action = closeAction(code);
      // Reconnecting here would take the slot back off whichever of this
      // account's clients the server handed it to, and that one reconnects and
      // takes it back -- a rotation nobody wins. A watcher is a process someone
      // started, so it says why it is stopping rather than idling silently.
      if (action === 'yield') {
        settle(
          new ApiError(
            429,
            'This account has too many open realtime connections; the server closed this one to make room. ' +
              'Close another client and start the watch again.'
          )
        );
        return;
      }
      if (action !== 'revalidate') {
        options.notify(`Realtime connection closed (code ${code}); reconnecting in ${backoff} ms`);
        scheduleReconnect();
        return;
      }
      // 4401 is also what an auth frame that never arrived gets, so one HTTP
      // round trip decides whether the credential is really gone.
      let stillValid = true;
      try {
        stillValid = await options.revalidateSession();
      } catch (err) {
        options.notify(`Could not check whether the session is still valid (${errorText(err)})`);
      }
      if (stopped || gen !== generation) return;
      if (!stillValid) {
        settle(new ApiError(401, 'The credential was revoked; the server closed the connection'));
        return;
      }
      options.notify(
        `Realtime connection closed with 4401 but the credential is still valid; reconnecting in ${backoff} ms`
      );
      scheduleReconnect();
    }

    function open(): void {
      if (stopped) return;
      generation += 1;
      const gen = generation;
      const handlers: WatchHandlers = {
        onOpen: () => {
          if (stopped || gen !== generation) return;
          send({ type: 'auth', token: options.token });
        },
        onMessage: (data) => {
          if (stopped || gen !== generation) return;
          onMessage(data, gen);
        },
        onClose: (code) => {
          if (stopped || gen !== generation) return;
          void onClose(code, gen);
        },
      };
      let opened: WatchSocket;
      try {
        opened = connect(options.url, handlers);
      } catch (err) {
        options.notify(
          `Could not open the realtime connection (${errorText(err)}); reconnecting in ${backoff} ms`
        );
        hadGap = true;
        scheduleReconnect();
        return;
      }
      socket = opened;
      armStaleTimer();
    }

    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (options.projectId === null) {
      refreshTimer = setInterval(() => void refreshProjects(), PROJECT_REFRESH_MS);
    }
    open();
  });
}
