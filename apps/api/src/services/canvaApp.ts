import { createHash, randomInt } from 'node:crypto';
import { type JWTPayload, createRemoteJWKSet, jwtVerify } from 'jose';
import type { Kysely, Transaction } from 'kysely';
import { CANVA_PAIRING_CODE_TTL_MINUTES } from '../config/constants.ts';
import { env } from '../config/env.ts';
import type { DB } from '../db/types.ts';
import { AppError } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';

type Connection = Kysely<DB> | Transaction<DB>;

export interface CanvaAppUser {
  canvaUserId: string;
  canvaBrandId: string | null;
}

// Built once per app id and reused, because createRemoteJWKSet caches the key
// set and honours its own cooldown. Rebuilding it per request would fetch the
// JWKS per request, which is both slow and a way to be rate-limited off the
// only endpoint that can verify anything.
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function keySetFor(appId: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = keySets.get(appId);
  if (existing) return existing;
  const created = createRemoteJWKSet(new URL(env.canva.jwksUrl));
  keySets.set(appId, created);
  return created;
}

// Exported for the tests, which stand up their own signing key and cannot share
// a cache keyed on an app id they also choose.
export function resetCanvaKeySets(): void {
  keySets.clear();
}

/**
 * Verifies a token minted by `auth.getCanvaUserToken()` in the Canva app.
 *
 * Three things are checked and each one matters on its own. The signature comes
 * from Canva's JWKS for this app id, which is what makes the token unforgeable.
 * The audience is pinned to our app id, without which a token issued to any
 * other app on Canva would authenticate here. And the expiry is Canva's own,
 * five minutes from issue, which is why nothing stores one of these.
 */
export async function verifyCanvaUserToken(token: string): Promise<CanvaAppUser> {
  const appId = env.canva.appId;
  if (appId === undefined) {
    // A server fault rather than a bad request: the caller's token may be
    // perfectly good, and there is nothing here to check it against. Not a boot
    // assertion like the proxy and SES ones, because a deployment that does not
    // want the Canva app is a deployment that should still start.
    throw new AppError(500, 'CANVA_APP_ID is not set on this server');
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keySetFor(appId), {
      audience: appId,
      algorithms: ['RS256'],
    }));
  } catch {
    // Deliberately not the underlying message. jose distinguishes an expired
    // token from a bad signature from an audience mismatch, and telling a
    // caller which of those it hit is a probe into how the check works.
    throw new AppError(401, 'That Canva token is not valid');
  }

  const canvaUserId = payload['userId'];
  if (typeof canvaUserId !== 'string' || canvaUserId.length === 0) {
    throw new AppError(401, 'That Canva token names no user');
  }
  const brand = payload['brandId'];

  return {
    canvaUserId,
    canvaBrandId: typeof brand === 'string' && brand.length > 0 ? brand : null,
  };
}

// No I, O, 0 or 1. The code is read off one screen and typed into another, and
// those four are the pairs that get typed wrong.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_GROUP = 4;

function generateCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${code.slice(0, CODE_GROUP)}-${code.slice(CODE_GROUP)}`;
}

// Upper-cased and stripped of everything the alphabet does not contain, so the
// hyphen the app displays is optional and a lower-case paste still works. The
// same normalization runs on both sides or the hashes cannot agree.
function normalizePairingCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/gu, '');
  return cleaned.length === CODE_LENGTH
    ? `${cleaned.slice(0, CODE_GROUP)}-${cleaned.slice(CODE_GROUP)}`
    : cleaned;
}

function hashCode(code: string): string {
  return createHash('sha256').update(normalizePairingCode(code)).digest('hex');
}

export interface PendingPairing {
  code: string;
  expiresAt: Date;
}

/**
 * Issues the code the app shows to somebody who has not linked their account.
 *
 * Replaces whatever live pairing that Canva user already had, which is what
 * `canva_app_pairing_one_live` enforces: a code left on a screen somebody
 * walked away from stops working the moment they ask for another.
 */
export async function startPairing(db: Connection, who: CanvaAppUser): Promise<PendingPairing> {
  await db
    .deleteFrom('canva_app_pairing')
    .where('canva_user_id', '=', who.canvaUserId)
    .where('claimed_at', 'is', null)
    .execute();

  const code = generateCode();
  const expiresAt = new Date(Date.now() + CANVA_PAIRING_CODE_TTL_MINUTES * 60 * 1000);

  await db
    .insertInto('canva_app_pairing')
    .values({
      id: newId(),
      code_hash: hashCode(code),
      canva_user_id: who.canvaUserId,
      canva_brand_id: who.canvaBrandId,
      expires_at: expiresAt,
    })
    .execute();

  return { code, expiresAt };
}

export interface CanvaLink {
  id: string;
  canva_brand_id: string | null;
  created_at: Date | string;
  last_used_at: Date | string | null;
}

/**
 * Spends a code on behalf of the signed-in user, which is the one moment the
 * two identities are in the same request.
 *
 * Expiry and reuse answer the same 404 as a code that never existed. A code is
 * eight characters of guessable alphabet, and an answer that distinguishes
 * "wrong" from "already used" turns it into an oracle worth grinding.
 */
export async function claimPairing(
  db: Connection,
  userId: string,
  rawCode: string
): Promise<CanvaLink> {
  const pairing = await db
    .selectFrom('canva_app_pairing')
    .select([
      'canva_app_pairing.id as id',
      'canva_app_pairing.canva_user_id as canva_user_id',
      'canva_app_pairing.canva_brand_id as canva_brand_id',
      'canva_app_pairing.expires_at as expires_at',
    ])
    .where('canva_app_pairing.code_hash', '=', hashCode(rawCode))
    .where('canva_app_pairing.claimed_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();

  if (!pairing || new Date(pairing.expires_at).getTime() <= Date.now()) {
    throw new AppError(404, 'That code is not valid. Ask the Canva app for a new one');
  }

  await db
    .updateTable('canva_app_pairing')
    .set({ claimed_at: new Date(), claimed_by: userId })
    .where('id', '=', pairing.id)
    .execute();

  // Re-linking the same Canva user moves it to whoever just proved they are
  // signed in, rather than refusing. Somebody with two accounts here pointing
  // one Canva login at the other is a thing to allow, and the unique on
  // canva_user_id is what keeps it to one at a time.
  const [link] = await db
    .insertInto('canva_app_link')
    .values({
      id: newId(),
      canva_user_id: pairing.canva_user_id,
      canva_brand_id: pairing.canva_brand_id,
      user_id: userId,
    })
    .onConflict((oc) =>
      oc.column('canva_user_id').doUpdateSet({
        user_id: userId,
        canva_brand_id: pairing.canva_brand_id,
        last_used_at: null,
      })
    )
    .returning(['id', 'canva_brand_id', 'created_at', 'last_used_at'])
    .execute();

  return link as CanvaLink;
}

export async function findLink(
  db: Connection,
  canvaUserId: string
): Promise<{ id: string; user_id: string } | undefined> {
  return await db
    .selectFrom('canva_app_link')
    .select(['canva_app_link.id as id', 'canva_app_link.user_id as user_id'])
    .where('canva_app_link.canva_user_id', '=', canvaUserId)
    .executeTakeFirst();
}

export async function listLinks(db: Connection, userId: string): Promise<CanvaLink[]> {
  return (await db
    .selectFrom('canva_app_link')
    .select([
      'canva_app_link.id as id',
      'canva_app_link.canva_brand_id as canva_brand_id',
      'canva_app_link.created_at as created_at',
      'canva_app_link.last_used_at as last_used_at',
    ])
    .where('canva_app_link.user_id', '=', userId)
    .orderBy('canva_app_link.created_at', 'desc')
    .execute()) as CanvaLink[];
}

// Scoped to the caller, so a link id belonging to somebody else is a 404 rather
// than a revocation of theirs.
export async function revokeLink(db: Connection, userId: string, linkId: string): Promise<void> {
  const deleted = await db
    .deleteFrom('canva_app_link')
    .where('id', '=', linkId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

  if (Number(deleted.numDeletedRows ?? 0) === 0) {
    throw new AppError(404, 'Link not found');
  }
}

export interface CanvaAppBuildReport {
  commit: string;
  branch: string;
  dirty: boolean;
  built_at: string;
}

export interface DeployedBuild extends Omit<CanvaAppBuildReport, 'built_at'> {
  built_at: Date | string;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
}

/**
 * Records that a bundle of this build is running. Every app load reports, so
 * the row is the build rather than the visit -- an upsert, with first_seen_at
 * deliberately left alone, because when a build went live is a different
 * question from when it was last used and only the insert can answer it.
 */
export async function recordAppBuild(db: Connection, report: CanvaAppBuildReport): Promise<void> {
  const builtAt = new Date(report.built_at);
  const seenAt = new Date();

  await db
    .insertInto('canva_app_build')
    .values({
      commit: report.commit,
      branch: report.branch,
      dirty: report.dirty,
      built_at: builtAt,
      first_seen_at: seenAt,
      last_seen_at: seenAt,
    })
    .onConflict((conflict) =>
      conflict.column('commit').doUpdateSet({
        branch: report.branch,
        dirty: report.dirty,
        built_at: builtAt,
        last_seen_at: seenAt,
      })
    )
    .execute();
}

// The portal serves one bundle, so the build seen most recently is the one it
// is serving. Older rows are the history of what has been.
export async function readLatestBuild(db: Connection): Promise<DeployedBuild | undefined> {
  return await db
    .selectFrom('canva_app_build')
    .select(['commit', 'branch', 'dirty', 'built_at', 'first_seen_at', 'last_seen_at'])
    .orderBy('last_seen_at', 'desc')
    .executeTakeFirst();
}
