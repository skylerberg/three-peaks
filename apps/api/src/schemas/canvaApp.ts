import { type } from 'arktype';
import { authResponseSchema } from './auth.ts';
import { stringWithLength } from './common.ts';

// A Canva app token is a JWT and nothing here parses it -- the bound is only so
// an unbounded body cannot be posted at the verifier.
const CANVA_TOKEN_MAX_LENGTH = 4096;

// Eight characters and a hyphen, but accepted loosely: the hyphen is optional
// and case does not matter, because normalizePairingCode folds both before
// anything is compared. Refusing a lower-case paste would be refusing the code
// we just showed somebody.
const PAIRING_CODE_MAX_LENGTH = 32;

// Nothing here parses either, so the bound is only so an unbounded string does
// not land in a column exactly as it arrived.
const BUILD_NAME_MAX_LENGTH = 200;

// What a bundle says it is, reported as the app opens. Optional, because the
// bundle the portal was serving when this shipped carries none -- and a release
// nobody can recognise is worth recognising as that rather than refusing.
export const canvaAppBuildReportSchema = type({
  commit: stringWithLength(1, BUILD_NAME_MAX_LENGTH),
  branch: stringWithLength(1, BUILD_NAME_MAX_LENGTH),
  // Taken from the bundle rather than worked out here: only the build knows
  // what its tree looked like.
  dirty: 'boolean',
  built_at: 'string.date.iso',
});

// The build the portal is serving: the newest one to have reported itself.
export const canvaAppBuildSchema = type({
  commit: 'string',
  branch: 'string',
  dirty: 'boolean',
  built_at: 'string',
  first_seen_at: 'string',
  last_seen_at: 'string',
});

export const canvaAppSessionRequestSchema = type({
  token: stringWithLength(1, CANVA_TOKEN_MAX_LENGTH),
  'build?': canvaAppBuildReportSchema,
  // Asks for a code even where this Canva user is already linked, which is the
  // only way somebody signed into the wrong account can say so from inside
  // Canva. It grants nothing on its own: a code still has to be spent by
  // somebody signed in here, and the existing link stands until one is.
  'switch_account?': 'boolean',
});

// Two answers behind one status, discriminated on `linked`. A 401 for the
// unlinked case would be wrong: the Canva token IS valid, and the app has
// somewhere to go next -- which is what the code is.
export const canvaAppLinkedSessionSchema = authResponseSchema.and({
  linked: 'true',
});

export const canvaAppPairingSchema = type({
  linked: 'false',
  pairing_code: 'string',
  expires_at: 'string',
});

export const canvaAppSessionSchema = canvaAppLinkedSessionSchema.or(canvaAppPairingSchema);

export const canvaAppPairRequestSchema = type({
  code: stringWithLength(1, PAIRING_CODE_MAX_LENGTH),
});

export const canvaAppLinkSchema = type({
  id: 'string',
  canva_brand_id: 'string | null',
  created_at: 'string',
  last_used_at: 'string | null',
});

export const canvaAppLinkListSchema = type({ links: canvaAppLinkSchema.array() });
