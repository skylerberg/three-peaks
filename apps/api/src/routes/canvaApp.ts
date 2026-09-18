import { Hono } from 'hono';
import { describeRoute, resolver } from 'hono-openapi';
import { skipAuth } from '../middleware/auth.ts';
import { jsonValidator } from '../middleware/validators.ts';
import {
  type CanvaAppBuildReport,
  claimPairing,
  findLink,
  listLinks,
  readLatestBuild,
  recordAppBuild,
  revokeLink,
  startPairing,
  verifyCanvaUserToken,
} from '../services/canvaApp.ts';
import { createSession } from '../services/sessions.ts';
import {
  internalServerErrorResponse,
  notFoundErrorResponse,
  unauthorizedErrorResponse,
  validationErrorResponse,
} from '../schemas/errors.ts';
import {
  canvaAppBuildSchema,
  canvaAppLinkListSchema,
  canvaAppLinkSchema,
  canvaAppPairRequestSchema,
  canvaAppSessionRequestSchema,
  canvaAppSessionSchema,
} from '../schemas/canvaApp.ts';
import { AppError } from '../utils/errors.ts';
import type { AppHono, PublicHono } from '../types/index.ts';

// Two routers on one mount, the way the auth router splits. The exchange is the
// only route here that runs without a token of ours, and it must not be able to
// borrow the marker from its neighbours.
export const publicCanvaAppRouter: PublicHono = new Hono();
export const canvaAppRouter: AppHono = new Hono();

const standardErrors = {
  ...unauthorizedErrorResponse,
  ...internalServerErrorResponse,
};

publicCanvaAppRouter.post(
  '/session',
  describeRoute({
    tags: ['Canva app'],
    summary: 'Exchange a Canva app token for a session',
    description:
      'The Canva app proves which Canva user is running it and nothing more. Where that user has been linked to an account here, this answers with an ordinary session — the same credential login issues, so the app then uses the whole API as any other client does and needs no surface of its own. Where they have not, it answers 200 with a pairing code for somebody signed in here to spend, because a valid token belonging to a stranger is not an authentication failure. `switch_account` asks for a code regardless, which is how somebody signed into the wrong account fixes it without leaving Canva.',
    responses: {
      200: {
        description: 'A session, or the code that leads to one',
        content: { 'application/json': { schema: resolver(canvaAppSessionSchema) } },
      },
      ...validationErrorResponse,
      ...standardErrors,
    },
  }),
  skipAuth,
  jsonValidator(canvaAppSessionRequestSchema),
  async (c) => {
    const body = c.req.valid('json') as {
      token: string;
      switch_account?: boolean;
      build?: CanvaAppBuildReport;
    };
    const who = await verifyCanvaUserToken(body.token);
    const db = c.get('db');

    // After the token is verified, so only a caller Canva vouches for writes a
    // row, and before the answer branches, because a bundle is running whether
    // or not the person in front of it has been linked yet.
    if (body.build !== undefined) await recordAppBuild(db, body.build);

    const link = body.switch_account === true ? undefined : await findLink(db, who.canvaUserId);
    if (!link) {
      const pairing = await startPairing(db, who);
      return c.json({
        linked: false as const,
        pairing_code: pairing.code,
        expires_at: pairing.expiresAt.toISOString(),
      });
    }

    const user = await db
      .selectFrom('app_user')
      .select(['id', 'email', 'name', 'email_verified'])
      .where('id', '=', link.user_id)
      .executeTakeFirstOrThrow();

    await db
      .updateTable('canva_app_link')
      .set({ last_used_at: new Date() })
      .where('id', '=', link.id)
      .execute();

    const session = await createSession(c, user.id);
    return c.json({
      linked: true as const,
      token: session.token,
      expires_at: session.expiresAt.toISOString(),
      user,
    });
  }
);

publicCanvaAppRouter.get(
  '/build',
  describeRoute({
    tags: ['Canva app'],
    summary: 'The bundle the Developer Portal is serving',
    description:
      'The newest build to have reported itself. The bundle is uploaded into the portal by hand and no Canva API reads it back, so what has run is the only evidence of what is up there. Answers 404 where nothing has reported, which means either that the bundle in the portal predates this or that nobody has opened the app since. Public for the reason /health names its own branch and commit: it identifies a release rather than saying anything about anybody, and `pnpm canva:release` reads it before it builds.',
    responses: {
      200: {
        description: 'The build',
        content: { 'application/json': { schema: resolver(canvaAppBuildSchema) } },
      },
      ...notFoundErrorResponse,
      ...internalServerErrorResponse,
    },
  }),
  skipAuth,
  async (c) => {
    const build = await readLatestBuild(c.get('db'));
    if (build === undefined) throw new AppError(404, 'No Canva app build has reported yet');
    return c.json(build);
  }
);

canvaAppRouter.post(
  '/pair',
  describeRoute({
    tags: ['Canva app'],
    summary: 'Link the Canva app to this account',
    description:
      'Spends the code the app is showing. This is the one request in which both identities are present — the Canva user in the code, and the account in the token — which is the whole reason a person has to make it. A code that has expired, been spent, or never existed answers the same 404: eight characters of a small alphabet is worth guessing at if the response says which.',
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: 'Linked',
        content: { 'application/json': { schema: resolver(canvaAppLinkSchema) } },
      },
      ...validationErrorResponse,
      ...notFoundErrorResponse,
      ...standardErrors,
    },
  }),
  jsonValidator(canvaAppPairRequestSchema),
  async (c) => {
    const { code } = c.req.valid('json') as { code: string };
    const link = await claimPairing(c.get('db'), c.get('user').id, code);
    return c.json(link, 201);
  }
);

canvaAppRouter.get(
  '/links',
  describeRoute({
    tags: ['Canva app'],
    summary: 'The Canva accounts linked to this one',
    description: 'Newest first. A link is a standing grant, so it is listable and revocable.',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: 'The links',
        content: { 'application/json': { schema: resolver(canvaAppLinkListSchema) } },
      },
      ...standardErrors,
    },
  }),
  async (c) => c.json({ links: await listLinks(c.get('db'), c.get('user').id) })
);

canvaAppRouter.delete(
  '/links/:linkId',
  describeRoute({
    tags: ['Canva app'],
    summary: 'Unlink a Canva account',
    description:
      'The app falls back to asking for a pairing code the next time it is opened. Sessions it was already given are not revoked by this — those are ended from the sessions list, like any other.',
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: 'Unlinked' },
      ...notFoundErrorResponse,
      ...standardErrors,
    },
  }),
  async (c) => {
    await revokeLink(c.get('db'), c.get('user').id, c.req.param('linkId'));
    return c.body(null, 204);
  }
);
