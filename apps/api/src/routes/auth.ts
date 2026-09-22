import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import { MAX_PERSONAL_ACCESS_TOKENS_PER_USER } from '@three-peaks/shared';
import {
  PASSWORD_RESET_TTL_MS,
  decodeSignedToken,
  encodeSignedToken,
} from '../services/signedToken.ts';
import { createSession, hashBearerToken } from '../services/sessions.ts';
import { generatePersonalAccessToken } from '../services/personalAccessTokens.ts';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../services/passwords.ts';
import { sendEmail } from '../services/email/index.ts';
import { passwordResetLink } from '../services/webLinks.ts';
import { skipAuth } from '../middleware/auth.ts';
import { jsonValidator } from '../middleware/validators.ts';
import { AppError, isUniqueViolation } from '../utils/errors.ts';
import { newId } from '../utils/uuid.ts';
import { APP_NAME } from '../config/constants.ts';
import {
  authResponseSchema,
  changePasswordRequestSchema,
  createPersonalAccessTokenRequestSchema,
  createdPersonalAccessTokenSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  personalAccessTokenListSchema,
  resetPasswordRequestSchema,
  sessionListSchema,
  signupRequestSchema,
  userSchema,
} from '../schemas/auth.ts';
import {
  conflictErrorResponse,
  internalServerErrorResponse,
  notFoundErrorResponse,
  unauthorizedErrorResponse,
  validationErrorResponse,
} from '../schemas/errors.ts';
import type { AppHono, AuthenticatedUser, PublicHono } from '../types/index.ts';

// Two routers on one mount prefix, because one Hono instance carries one
// context type. The public half's handlers see `user` as possibly undefined;
// the authed half's see a user. Never reach for `use('*', skipAuth)` on a
// sub-router — it would match every sibling sharing this prefix.
export const publicAuthRouter: PublicHono = new Hono();
export const authRouter: AppHono = new Hono();

function toUser(row: {
  id: string;
  email: string;
  name: string;
  email_verified: boolean;
}): AuthenticatedUser {
  return { id: row.id, email: row.email, name: row.name, email_verified: row.email_verified };
}

publicAuthRouter.post(
  '/signup',
  describeRoute({
    tags: ['Auth'],
    summary: 'Create an account',
    description: 'Creates an account and returns a session token.',
    responses: {
      201: {
        description: 'Account created',
        content: { 'application/json': { schema: resolver(authResponseSchema) } },
      },
      ...conflictErrorResponse,
      ...validationErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  skipAuth,
  jsonValidator(signupRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as {
      id?: string;
      email: string;
      password: string;
      name: string;
    };
    const db = c.get('db');
    const id = body.id ?? newId();

    let inserted;
    try {
      inserted = await db
        .insertInto('app_user')
        .values({
          id,
          email: body.email,
          password_hash: await hashPassword(body.password),
          name: body.name,
        })
        .returning(['id', 'email', 'name', 'email_verified'])
        .executeTakeFirstOrThrow();
    } catch (error) {
      // The lower(email) unique index and the primary key both land here. A
      // pre-check would race: two signups for one address can both pass it.
      if (isUniqueViolation(error)) throw new AppError(409, 'An account with that email exists');
      throw error;
    }

    const session = await createSession(c, inserted.id);
    return c.json(
      {
        token: session.token,
        expires_at: session.expiresAt.toISOString(),
        user: toUser(inserted),
      },
      201
    );
  }
);

publicAuthRouter.post(
  '/login',
  describeRoute({
    tags: ['Auth'],
    summary: 'Sign in',
    description: 'Exchanges an email and password for a session token.',
    responses: {
      200: {
        description: 'Signed in',
        content: { 'application/json': { schema: resolver(authResponseSchema) } },
      },
      ...unauthorizedErrorResponse,
      ...validationErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  skipAuth,
  jsonValidator(loginRequestSchema),
  async (c) => {
    const { email, password } = c.req.valid('json') as { email: string; password: string };
    const db = c.get('db');

    const row = await db
      .selectFrom('app_user')
      .select([
        'app_user.id as id',
        'app_user.email as email',
        'app_user.name as name',
        'app_user.email_verified as email_verified',
        'app_user.password_hash as password_hash',
      ])
      .where((eb) => eb(eb.fn('lower', ['app_user.email']), '=', email.toLowerCase()))
      .executeTakeFirst();

    if (!row) {
      // Spend the same time an argon2 verify would, so "no such account" and
      // "wrong password" are not distinguishable by a stopwatch.
      await verifyDummyPassword(password);
      throw new AppError(401, 'Invalid email or password');
    }

    if (!(await verifyPassword(row.password_hash, password))) {
      throw new AppError(401, 'Invalid email or password');
    }

    const session = await createSession(c, row.id);
    return c.json({
      token: session.token,
      expires_at: session.expiresAt.toISOString(),
      user: toUser(row),
    });
  }
);

publicAuthRouter.post(
  '/forgot-password',
  describeRoute({
    tags: ['Auth'],
    summary: 'Request a password reset',
    description:
      'Sends a reset link to an address that has an account. Answers 404 for one that does not.',
    responses: {
      204: { description: 'Reset email enqueued' },
      ...notFoundErrorResponse,
      ...validationErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  skipAuth,
  jsonValidator(forgotPasswordRequestSchema),
  async (c) => {
    const { email } = c.req.valid('json') as { email: string };
    const db = c.get('db');

    const row = await db
      .selectFrom('app_user')
      .select(['app_user.id as id', 'app_user.alternative_id as alternative_id'])
      .where((eb) => eb(eb.fn('lower', ['app_user.email']), '=', email.toLowerCase()))
      .executeTakeFirst();

    // Deliberately informative. Signup already answers 409 for an address in
    // use, unauthenticated, so a non-revealing forgot-password buys nothing and
    // costs every mistyped address a silent wait.
    if (!row) throw new AppError(404, 'No account with that email');

    const token = encodeSignedToken(
      'reset',
      { sub: row.id, alt: row.alternative_id },
      PASSWORD_RESET_TTL_MS
    );

    // Post-commit: nothing is mailed for a request that ends up rolling back.
    c.get('postCommitHooks').push(async () => {
      await sendEmail({
        to: email,
        subject: `Reset your ${APP_NAME} password`,
        text: `Open this link to choose a new password. It expires in 15 minutes.\n\n${passwordResetLink(token)}\n\nIf you did not ask for this, you can ignore it.`,
      });
    });

    return c.body(null, 204);
  }
);

publicAuthRouter.post(
  '/reset-password',
  describeRoute({
    tags: ['Auth'],
    summary: 'Set a new password from a reset link',
    description:
      'Consumes a reset token. Rotating alternative_id is what makes the link single-use; sessions are deliberately left signed in.',
    responses: {
      204: { description: 'Password changed' },
      ...unauthorizedErrorResponse,
      ...validationErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  skipAuth,
  jsonValidator(resetPasswordRequestSchema),
  async (c) => {
    const { token, password } = c.req.valid('json') as { token: string; password: string };
    const claims = decodeSignedToken<{ sub: string; alt: string }>('reset', token);
    if (!claims) throw new AppError(401, 'That reset link is invalid or has expired');

    const db = c.get('db');
    const result = await db
      .updateTable('app_user')
      .set({
        password_hash: await hashPassword(password),
        // Rotating this invalidates the link that was just spent, and every
        // other outstanding one for this account.
        alternative_id: newId(),
        updated_at: new Date(),
      })
      .where('app_user.id', '=', claims.sub)
      .where('app_user.alternative_id', '=', claims.alt)
      .executeTakeFirst();

    if (Number(result.numUpdatedRows) === 0) {
      throw new AppError(401, 'That reset link is invalid or has expired');
    }

    return c.body(null, 204);
  }
);

authRouter.get(
  '/me',
  describeRoute({
    tags: ['Auth'],
    summary: 'The signed-in account',
    description: 'Returns the account the presented token belongs to.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The account',
        content: { 'application/json': { schema: resolver(userSchema) } },
      },
      ...unauthorizedErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  (c) => c.json(c.get('user'))
);

authRouter.post(
  '/logout',
  describeRoute({
    tags: ['Auth'],
    summary: 'Sign out',
    description: 'Revokes the session the request was authenticated with.',
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Signed out' },
      ...unauthorizedErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  async (c) => {
    const credential = c.get('credential');
    if (credential?.kind === 'session') {
      await c.get('db').deleteFrom('session').where('id', '=', credential.id).execute();
    }
    return c.body(null, 204);
  }
);

authRouter.get(
  '/sessions',
  describeRoute({
    tags: ['Auth'],
    summary: 'List active sessions',
    description: 'Every unexpired session for this account, newest first.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Active sessions',
        content: { 'application/json': { schema: resolver(sessionListSchema) } },
      },
      ...unauthorizedErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  async (c) => {
    const credential = c.get('credential');
    const rows = await c
      .get('db')
      .selectFrom('session')
      .select([
        'session.id as id',
        'session.user_agent as user_agent',
        'session.created_at as created_at',
        'session.expires_at as expires_at',
      ])
      .where('session.user_id', '=', c.get('user').id)
      .where('session.expires_at', '>', new Date())
      .orderBy('session.created_at', 'desc')
      .execute();

    return c.json({
      sessions: rows.map((row) => ({
        id: row.id,
        user_agent: row.user_agent,
        created_at: new Date(row.created_at).toISOString(),
        expires_at: new Date(row.expires_at).toISOString(),
        current: credential?.kind === 'session' && credential.id === row.id,
      })),
    });
  }
);

authRouter.delete(
  '/sessions/:id',
  describeRoute({
    tags: ['Auth'],
    summary: 'Revoke a session',
    description: 'Signs out one session. Revoking the current one is allowed.',
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Revoked' },
      ...notFoundErrorResponse,
      ...unauthorizedErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  async (c) => {
    const result = await c
      .get('db')
      .deleteFrom('session')
      .where('session.id', '=', c.req.param('id'))
      // Scoped to the caller, so an id belonging to someone else is a 404
      // rather than a 403 that confirms it exists.
      .where('session.user_id', '=', c.get('user').id)
      .executeTakeFirst();

    if (Number(result.numDeletedRows) === 0) throw new AppError(404, 'Session not found');
    return c.body(null, 204);
  }
);

authRouter.post(
  '/change-password',
  describeRoute({
    tags: ['Auth'],
    summary: 'Change password',
    description:
      'Requires the current password. Leaves every session signed in, including this one, so no replacement token is issued.',
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Password changed' },
      ...unauthorizedErrorResponse,
      ...validationErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  jsonValidator(changePasswordRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as { current_password: string; new_password: string };
    const db = c.get('db');
    const user = c.get('user');

    const row = await db
      .selectFrom('app_user')
      .select(['app_user.password_hash as password_hash'])
      .where('app_user.id', '=', user.id)
      .executeTakeFirst();

    if (!row || !(await verifyPassword(row.password_hash, body.current_password))) {
      throw new AppError(401, 'Current password is incorrect');
    }

    await db
      .updateTable('app_user')
      .set({
        password_hash: await hashPassword(body.new_password),
        alternative_id: newId(),
        updated_at: new Date(),
      })
      .where('app_user.id', '=', user.id)
      .execute();

    return c.body(null, 204);
  }
);

function toTokenResponse(row: {
  id: string;
  name: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
}) {
  return {
    id: row.id,
    name: row.name,
    created_at: new Date(row.created_at).toISOString(),
    last_used_at: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
  };
}

authRouter.get(
  '/tokens',
  describeRoute({
    tags: ['Auth'],
    summary: 'List personal access tokens',
    description:
      "The caller's personal access tokens, newest first. Secrets are never returned. `last_used_at` is null until a token first authenticates, and is accurate to about a minute after that.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'Personal access tokens',
        content: { 'application/json': { schema: resolver(personalAccessTokenListSchema) } },
      },
      ...unauthorizedErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  async (c) => {
    const rows = await c
      .get('db')
      .selectFrom('personal_access_token')
      .select([
        'personal_access_token.id as id',
        'personal_access_token.name as name',
        'personal_access_token.created_at as created_at',
        'personal_access_token.last_used_at as last_used_at',
      ])
      .where('personal_access_token.user_id', '=', c.get('user').id)
      .orderBy('personal_access_token.created_at', 'desc')
      .orderBy('personal_access_token.id')
      .execute();

    return c.json({ personal_access_tokens: rows.map(toTokenResponse) });
  }
);

authRouter.post(
  '/tokens',
  describeRoute({
    tags: ['Auth'],
    summary: 'Create a personal access token',
    description:
      'A named token for scripts and agents, carrying the same access as the account. The secret is in this response and nowhere else; only its hash is stored. Tokens do not expire and survive password changes -- revoking one is the only way it stops working.',
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'Created; the secret is in this response only',
        content: { 'application/json': { schema: resolver(createdPersonalAccessTokenSchema) } },
      },
      ...conflictErrorResponse,
      ...validationErrorResponse,
      ...unauthorizedErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  jsonValidator(createPersonalAccessTokenRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as { id?: string; name: string };
    const db = c.get('db');
    const user = c.get('user');

    const { count } = await db
      .selectFrom('personal_access_token')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('personal_access_token.user_id', '=', user.id)
      .executeTakeFirstOrThrow();
    if (Number(count) >= MAX_PERSONAL_ACCESS_TOKENS_PER_USER) {
      throw new AppError(
        422,
        `You already have ${MAX_PERSONAL_ACCESS_TOKENS_PER_USER} personal access tokens; revoke one before creating another`
      );
    }

    const token = generatePersonalAccessToken();
    try {
      const row = await db
        .insertInto('personal_access_token')
        .values({
          id: body.id ?? newId(),
          user_id: user.id,
          name: body.name,
          token_hash: hashBearerToken(token),
        })
        .returning(['id', 'name', 'created_at', 'last_used_at'])
        .executeTakeFirstOrThrow();
      return c.json({ token, personal_access_token: toTokenResponse(row) }, 201);
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'A token with that id exists');
      throw error;
    }
  }
);

authRouter.delete(
  '/tokens/:id',
  describeRoute({
    tags: ['Auth'],
    summary: 'Revoke a personal access token',
    description:
      "The token stops authenticating at once. Sessions and other tokens are untouched. Another account's token answers 404, the same as one that does not exist.",
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Revoked' },
      ...notFoundErrorResponse,
      ...unauthorizedErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  async (c) => {
    const result = await c
      .get('db')
      .deleteFrom('personal_access_token')
      .where('personal_access_token.id', '=', c.req.param('id'))
      .where('personal_access_token.user_id', '=', c.get('user').id)
      .executeTakeFirst();

    if (Number(result.numDeletedRows) === 0) throw new AppError(404, 'Token not found');
    return c.body(null, 204);
  }
);
