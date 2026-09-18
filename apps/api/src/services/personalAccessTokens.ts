import { randomBytes } from 'node:crypto';
import { PERSONAL_ACCESS_TOKEN_PREFIX } from '@three-peaks/shared';
import { pool } from '../db/index.ts';

export { PERSONAL_ACCESS_TOKEN_PREFIX };

// The prefix is what lets authentication look in the right table first, and
// what makes a leaked token recognisable to a secret scanner.
export function generatePersonalAccessToken(): string {
  return `${PERSONAL_ACCESS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

const LAST_USED_WRITE_INTERVAL_MS = 60_000;
const lastWrittenAt = new Map<string, number>();

// Deliberately on the pool rather than the request transaction. On the
// transaction it would be rolled back with any failed request, and it would
// hold a row lock for the life of that request — turning every concurrent call
// authenticated by one token into a queue.
export function touchPersonalAccessToken(tokenId: string): void {
  const now = Date.now();
  const previous = lastWrittenAt.get(tokenId);
  if (previous !== undefined && now - previous < LAST_USED_WRITE_INTERVAL_MS) return;
  lastWrittenAt.set(tokenId, now);

  void pool
    .query('update personal_access_token set last_used_at = now() where id = $1', [tokenId])
    .catch(() => {
      // Best effort. A failed bookkeeping write must not fail the request it
      // is attached to.
      lastWrittenAt.delete(tokenId);
    });
}

export function resetPersonalAccessTokenCache(): void {
  lastWrittenAt.clear();
}
