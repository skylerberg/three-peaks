import type { WebSocket } from 'ws';
import { CLOSE_CODES } from './closeCodes.ts';
import type { Credential } from '../../types/index.ts';

// Per-process ceilings. The fleet-wide figure is these times the replica count:
// they bound what one process can be made to hold, not what one person may have.
const MAX_SOCKETS_PER_ACCOUNT = 20;
export const MAX_SUBSCRIPTIONS_PER_SOCKET = 1000;

export interface Connection {
  socket: WebSocket;
  userId: string;
  credentialKind: Credential['kind'];
  credentialId: string;
  projects: Set<string>;
  alive: boolean;
}

const connections = new Set<Connection>();
const byUser = new Map<string, Set<Connection>>();

export function register(connection: Connection): void {
  connections.add(connection);
  let forUser = byUser.get(connection.userId);
  if (!forUser) {
    forUser = new Set();
    byUser.set(connection.userId, forUser);
  }
  forUser.add(connection);

  // Closes the OLDEST rather than refusing the newest, so a client reconnecting
  // after a network blip is never turned away by the stale socket it is
  // replacing.
  while (forUser.size > MAX_SOCKETS_PER_ACCOUNT) {
    const oldest = forUser.values().next().value;
    if (!oldest) break;
    unregister(oldest);
    oldest.socket.close(CLOSE_CODES.REPLACED, 'replaced by a newer connection');
  }
}

export function unregister(connection: Connection): void {
  connections.delete(connection);
  const forUser = byUser.get(connection.userId);
  if (!forUser) return;
  forUser.delete(connection);
  if (forUser.size === 0) byUser.delete(connection.userId);
}

export function connectionsForProject(projectId: string): Connection[] {
  return [...connections].filter((connection) => connection.projects.has(projectId));
}

export function allConnections(): Connection[] {
  return [...connections];
}

export function resetConnectionsForTests(): void {
  connections.clear();
  byUser.clear();
}
