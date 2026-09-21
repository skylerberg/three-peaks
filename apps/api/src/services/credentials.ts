import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../db/types.ts';
import { hashBearerToken, renewSession, sessionRenewalIsDue } from './sessions.ts';
import { PERSONAL_ACCESS_TOKEN_PREFIX, touchPersonalAccessToken } from './personalAccessTokens.ts';
import type { Credential } from '../types/index.ts';

type Connection = Kysely<DB> | Transaction<DB>;

export async function authenticateBearerToken(
  db: Connection,
  token: string
): Promise<Credential | null> {
  const tokenHash = hashBearerToken(token);

  if (token.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)) {
    const row = await db
      .selectFrom('personal_access_token as pat')
      .innerJoin('app_user as u', 'u.id', 'pat.user_id')
      .select([
        'pat.id as pat_id',
        'u.id as user_id',
        'u.email as email',
        'u.name as name',
        'u.email_verified as email_verified',
      ])
      .where('pat.token_hash', '=', tokenHash)
      .executeTakeFirst();

    if (row) {
      touchPersonalAccessToken(row.pat_id);
      return {
        kind: 'personal_access_token',
        id: row.pat_id,
        user: {
          id: row.user_id,
          email: row.email,
          name: row.name,
          email_verified: row.email_verified,
        },
      };
    }
    // Falls through to sessions rather than returning null: a base64url session
    // token can legitimately begin with the same characters as the prefix.
  }

  const row = await db
    .selectFrom('session as s')
    .innerJoin('app_user as u', 'u.id', 's.user_id')
    .select([
      's.id as session_id',
      's.expires_at as expires_at',
      'u.id as user_id',
      'u.email as email',
      'u.name as name',
      'u.email_verified as email_verified',
    ])
    .where('s.token_hash', '=', tokenHash)
    .executeTakeFirst();

  if (!row) return null;

  const expiresAt = new Date(row.expires_at);

  if (expiresAt.getTime() <= Date.now()) {
    // Best effort: an expired session that fails to delete is still refused.
    await db
      .deleteFrom('session')
      .where('id', '=', row.session_id)
      .execute()
      .catch(() => {});
    return null;
  }

  // Expiry is idle-based, so using a session is what keeps it: see
  // SESSION_TTL_DAYS.
  if (sessionRenewalIsDue(expiresAt)) renewSession(row.session_id);

  return {
    kind: 'session',
    id: row.session_id,
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      email_verified: row.email_verified,
    },
  };
}
