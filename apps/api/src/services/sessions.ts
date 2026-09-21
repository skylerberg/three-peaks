import { createHash, randomBytes } from 'node:crypto';
import { SESSION_TTL_DAYS } from '../config/constants.ts';
import { pool } from '../db/index.ts';
import { newId } from '../utils/uuid.ts';
import type { AnyContextGetter } from '../types/index.ts';

const USER_AGENT_MAX_LENGTH = 512;

function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

// Bearer tokens are compared by hash, so what the database holds is not a
// credential. sha256 rather than argon2 deliberately: the token is 256 bits of
// entropy already, so there is nothing to brute-force, and every authenticated
// request pays this cost.
export function hashBearerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

function sessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

// The halfway mark is what keeps a sliding expiry from costing a write per
// request: a session in constant use is written about twice a TTL, and one
// coming back at any point in the second half of its life is carried forward
// before it can lapse.
export function sessionRenewalIsDue(expiresAt: Date): boolean {
  return expiresAt.getTime() - Date.now() < SESSION_TTL_MS / 2;
}

// Deliberately on the pool and unawaited, for the reasons written on
// touchPersonalAccessToken: on the request transaction this would hold the
// session's row lock for the life of the request and be rolled back with any
// failure. The WHERE repeats the due check rather than trusting the caller's,
// so requests arriving together collapse to one write instead of each pushing
// the expiry out again. Nothing reads the result — an expiry that fails to move
// is renewed by the next request, which is due too.
export function renewSession(sessionId: string): void {
  void pool
    .query('update session set expires_at = $2 where id = $1 and expires_at < $3', [
      sessionId,
      sessionExpiry(),
      new Date(Date.now() + SESSION_TTL_MS / 2),
    ])
    .catch(() => {
      // Best effort. A failed bookkeeping write must never turn a live
      // credential into a 401.
    });
}

export interface CreatedSession {
  id: string;
  token: string;
  expiresAt: Date;
}

// Takes the request context rather than a connection, so no call site can
// forget to record the user agent — the sessions list is unusable without it.
export async function createSession(
  c: AnyContextGetter & { req: { header: (name: string) => string | undefined } },
  userId: string
): Promise<CreatedSession> {
  const db = c.get('db');
  const token = generateSessionToken();
  const id = newId();
  const expiresAt = sessionExpiry();
  const userAgent = c.req.header('user-agent')?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;

  await db
    .insertInto('session')
    .values({
      id,
      user_id: userId,
      token_hash: hashBearerToken(token),
      user_agent: userAgent,
      expires_at: expiresAt,
    })
    .execute();

  return { id, token, expiresAt };
}
