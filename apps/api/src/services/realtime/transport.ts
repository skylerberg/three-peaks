import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ExpressionBuilder } from 'kysely';
import type { DB } from '../../db/types.ts';
import { db } from '../../db/index.ts';
import { authenticateBearerToken } from '../credentials.ts';
import { logger } from '../../utils/logger.ts';
import { isValidUuid } from '../../utils/uuid.ts';
import { CLOSE_CODES } from './closeCodes.ts';
import { subscribeToBus } from './bus.ts';
import {
  MAX_SUBSCRIPTIONS_PER_SOCKET,
  allConnections,
  connectionsForProject,
  register,
  unregister,
  type Connection,
} from './state.ts';

const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024;

// /ws is served on the raw HTTP upgrade and is deliberately never part of the
// OpenAPI spec -- it has no request or response to describe. Its event types
// are published as a separate document instead.
export function attachRealtime(server: Server): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (socket: WebSocket) => {
    let connection: Connection | null = null;

    // A socket that never presents a credential is not one this process keeps.
    const authTimer = setTimeout(() => {
      if (!connection) socket.close(CLOSE_CODES.UNAUTHORIZED, 'no credential presented');
    }, AUTH_TIMEOUT_MS);

    // Only one auth frame is ever acted on. Frames from one read dispatch
    // synchronously, so without this a client could start a credential lookup
    // per frame against a pool of ten, and two resolving together would both
    // register -- the second replacing the first's subscription set and
    // stranding its rooms.
    let authenticating = false;

    socket.on('message', async (raw) => {
      let frame: { type?: string; token?: string; project_id?: string };
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }

      if (frame.type === 'auth') {
        if (connection || authenticating) return;
        authenticating = true;

        const credential = frame.token
          ? await authenticateBearerToken(db, frame.token).catch(() => null)
          : null;

        if (!credential) {
          authenticating = false;
          socket.close(CLOSE_CODES.UNAUTHORIZED, 'invalid credential');
          return;
        }

        clearTimeout(authTimer);
        connection = {
          socket,
          userId: credential.user.id,
          credentialKind: credential.kind,
          credentialId: credential.id,
          projects: new Set(),
          alive: true,
        };
        register(connection);
        authenticating = false;
        socket.send(JSON.stringify({ type: 'ready' }));
        return;
      }

      if (!connection) return;

      // A protocol-level ping is answered by the client's WebSocket without
      // telling the code above it, so a client that wants to know the socket
      // is alive asks here. It is also where a quiet socket learns that its
      // credential has gone, rather than at an event that may never come.
      if (frame.type === 'ping') {
        const current = connection;
        if (!(await credentialIsLive(current))) {
          revoke(current);
          return;
        }
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (frame.type === 'subscribe' && frame.project_id) {
        // An unvalidated project id is a room key whose length and number the
        // caller picks; a differently-cased one names a room no publish can
        // reach.
        const projectId = frame.project_id.toLowerCase();
        if (!isValidUuid(projectId)) return;
        if (connection.projects.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) return;

        // Subscribing is not authorization. Delivery re-checks access per event,
        // so a socket may name a project it cannot read and simply receive
        // nothing for it.
        connection.projects.add(projectId);
        return;
      }

      if (frame.type === 'unsubscribe' && frame.project_id) {
        connection.projects.delete(frame.project_id.toLowerCase());
      }
    });

    socket.on('pong', () => {
      if (connection) connection.alive = true;
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (connection) unregister(connection);
    });

    socket.on('error', () => {
      clearTimeout(authTimer);
      if (connection) unregister(connection);
    });
  });

  // Delivery re-checks access for every event rather than trusting the
  // subscription, so membership removed mid-connection takes effect at once.
  const unsubscribeBus = subscribeToBus((entry) => {
    const projectId = entry.project_id;
    if (!projectId) return;

    // The envelope goes out as it arrived: { type, project_id, data }. It was
    // flattened to { type, ...payload } while every payload was a bag of ids,
    // which stops working the moment one is a row -- a file's own id and its
    // project's would both be spelled the same at the top level.
    // packages/shared's generated union describes this shape, and
    // tests/e2e/realtime.test.ts holds the two together.
    const message = JSON.stringify(entry);
    void (async () => {
      for (const connection of connectionsForProject(projectId)) {
        try {
          const verdict = await deliverable(connection, projectId);
          if (verdict === 'revoked') revoke(connection);
          else if (verdict === 'allowed') connection.socket.send(message);
        } catch (error) {
          logger.error('realtime delivery failed', { error });
        }
      }
    })();
  });

  // A half-open connection -- one whose peer vanished without a FIN -- holds a
  // descriptor and a subscription set forever unless something notices. Each
  // tick terminates whatever did not answer the previous one.
  const heartbeat = setInterval(() => {
    for (const connection of allConnections()) {
      if (!connection.alive) {
        unregister(connection);
        connection.socket.terminate();
        continue;
      }
      connection.alive = false;
      connection.socket.ping();
    }
  }, HEARTBEAT_MS);

  return () => {
    clearInterval(heartbeat);
    unsubscribeBus();
    wss.close();
  };
}

function revoke(connection: Connection): void {
  unregister(connection);
  connection.socket.close(CLOSE_CODES.UNAUTHORIZED, 'credential revoked');
}

// The credential is re-checked alongside access, for the same reason access is:
// a socket authenticated once must not outlive what authenticated it. Signing a
// session out, or revoking a token, then stops delivery on every replica at the
// next event, with no message between replicas to carry the news.
function liveCredential(
  eb: ExpressionBuilder<DB, never>,
  connection: Connection
): ReturnType<ExpressionBuilder<DB, never>['exists']> {
  return connection.credentialKind === 'session'
    ? eb.exists(
        eb
          .selectFrom('session')
          .select('session.id')
          .where('session.id', '=', connection.credentialId)
          .where('session.expires_at', '>', new Date())
      )
    : eb.exists(
        eb
          .selectFrom('personal_access_token')
          .select('personal_access_token.id')
          .where('personal_access_token.id', '=', connection.credentialId)
      );
}

async function credentialIsLive(connection: Connection): Promise<boolean> {
  const row = await db
    .selectNoFrom((eb) => liveCredential(eb, connection).as('live'))
    .executeTakeFirstOrThrow();
  return Boolean(row.live);
}

async function deliverable(
  connection: Connection,
  projectId: string
): Promise<'allowed' | 'denied' | 'revoked'> {
  const userId = connection.userId;
  const row = await db
    .selectNoFrom((eb) => [
      liveCredential(eb, connection).as('live'),
      eb
        .exists(
          eb
            .selectFrom('project as p')
            .leftJoin('project_member as m', (join) =>
              join.onRef('m.project_id', '=', 'p.id').on('m.user_id', '=', userId)
            )
            .select('p.id')
            .where('p.id', '=', projectId)
            .where((inner) =>
              inner.or([inner('p.created_by', '=', userId), inner('m.user_id', 'is not', null)])
            )
        )
        .as('allowed'),
    ])
    .executeTakeFirstOrThrow();

  if (!row.live) return 'revoked';
  return row.allowed ? 'allowed' : 'denied';
}
