import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  anonymous,
  createUser,
  deleteUser,
  uniqueEmail,
  type TestUser,
} from '../setup/testContext.ts';
import { sentEmails } from '../../src/services/email/index.ts';
import { db } from '../../src/db/index.ts';
import { hashBearerToken } from '../../src/services/sessions.ts';
import { SESSION_TTL_DAYS } from '../../src/config/constants.ts';

describe('auth', () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createUser('auth');
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  describe('signup', () => {
    it('creates an account and returns a usable token', async () => {
      const email = uniqueEmail('signup');
      const res = await anonymous.post('/api/auth/signup', {
        email,
        password: 'correct horse battery staple',
        name: 'New Person',
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.user.email).toBe(email);
      expect(body.user.email_verified).toBe(false);
      expect(body.token).toBeTypeOf('string');

      const me = await anonymous.withToken(body.token).get('/api/auth/me');
      expect(me.status).toBe(200);
      expect((await me.json()).id).toBe(body.user.id);

      await deleteUser({ ...body.user, token: body.token, api: anonymous } as TestUser);
    });

    it('answers 409 for an address already in use, case-insensitively', async () => {
      const res = await anonymous.post('/api/auth/signup', {
        email: user.email.toUpperCase(),
        password: 'correct horse battery staple',
        name: 'Impostor',
      });
      expect(res.status).toBe(409);
    });

    it('answers 422 for a password under the minimum', async () => {
      const res = await anonymous.post('/api/auth/signup', {
        email: uniqueEmail('short'),
        password: 'short',
        name: 'Person',
      });
      expect(res.status).toBe(422);
      expect((await res.json()).details).toBeInstanceOf(Array);
    });

    it('strips fields the schema does not declare', async () => {
      const email = uniqueEmail('strip');
      const res = await anonymous.post('/api/auth/signup', {
        email,
        password: 'correct horse battery staple',
        name: 'Person',
        email_verified: true,
      });
      expect(res.status).toBe(201);
      // The undeclared key was dropped rather than written: a client cannot
      // verify its own address by asking.
      expect((await res.json()).user.email_verified).toBe(false);
    });
  });

  describe('login', () => {
    it('exchanges credentials for a token', async () => {
      const res = await anonymous.post('/api/auth/login', {
        email: user.email,
        password: 'correct horse battery staple',
      });
      expect(res.status).toBe(200);
      expect((await res.json()).user.id).toBe(user.id);
    });

    it('answers 401 for a wrong password', async () => {
      const res = await anonymous.post('/api/auth/login', {
        email: user.email,
        password: 'not the password',
      });
      expect(res.status).toBe(401);
    });

    // The same status and the same body for both, so neither the response nor
    // its shape says whether the address has an account.
    it('answers 401 identically for an unknown address', async () => {
      const unknown = await anonymous.post('/api/auth/login', {
        email: uniqueEmail('nobody'),
        password: 'not the password',
      });
      const wrong = await anonymous.post('/api/auth/login', {
        email: user.email,
        password: 'not the password',
      });

      expect(unknown.status).toBe(401);
      expect(await unknown.json()).toEqual(await wrong.json());
    });
  });

  describe('the auth boundary', () => {
    it.each([
      ['GET', '/api/auth/me'],
      ['GET', '/api/auth/sessions'],
      ['GET', '/api/projects'],
      ['GET', '/api/files/directory?project_id=00000000-0000-4000-8000-000000000000'],
    ])('refuses %s %s without a token', async (method, path) => {
      const res = await anonymous[method.toLowerCase() as 'get'](path);
      expect(res.status).toBe(401);
    });

    it('refuses a token that is not a real credential', async () => {
      const res = await anonymous.withToken('not-a-real-token').get('/api/auth/me');
      expect(res.status).toBe(401);
    });

    it.each([['/health'], ['/'], ['/api/openapi.json']])(
      'serves %s without a token',
      async (path) => {
        const res = await anonymous.get(path);
        expect(res.status).toBe(200);
      }
    );
  });

  describe('sessions', () => {
    it('lists the current session and marks it current', async () => {
      const res = await user.api.get('/api/auth/sessions');
      expect(res.status).toBe(200);
      const { sessions } = await res.json();
      expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    });

    it('signs out only the session that was used', async () => {
      const second = await anonymous.post('/api/auth/login', {
        email: user.email,
        password: 'correct horse battery staple',
      });
      const secondToken = (await second.json()).token;

      const logout = await anonymous.withToken(secondToken).post('/api/auth/logout');
      expect(logout.status).toBe(204);

      expect((await anonymous.withToken(secondToken).get('/api/auth/me')).status).toBe(401);
      // The first session is untouched.
      expect((await user.api.get('/api/auth/me')).status).toBe(200);
    });

    it('answers 404 for a session id belonging to someone else', async () => {
      const other = await createUser('other');
      const { sessions } = await (await other.api.get('/api/auth/sessions')).json();

      // 404 rather than 403: a 403 would confirm the id exists.
      const res = await user.api.delete(`/api/auth/sessions/${sessions[0].id}`);
      expect(res.status).toBe(404);

      expect((await other.api.get('/api/auth/me')).status).toBe(200);
      await deleteUser(other);
    });
  });

  // Expiry is idle-based: the clock restarts on use, so the only sessions that
  // lapse are the ones nobody came back to. Nothing else here would notice that
  // going away — a renewal that quietly stopped happening reads as somebody
  // being signed out a year later, by which time it is nobody's open branch.
  describe('session renewal', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const TTL_MS = SESSION_TTL_DAYS * DAY_MS;

    // A real login, then the row aged by hand: nothing else can produce a
    // session far enough into its life to be worth renewing.
    async function sessionExpiring(expiresAt: Date): Promise<{ id: string; token: string }> {
      const res = await anonymous.post('/api/auth/login', {
        email: user.email,
        password: 'correct horse battery staple',
      });
      expect(res.status).toBe(200);
      const token = (await res.json()).token as string;

      const row = await db
        .selectFrom('session')
        .select('session.id')
        .where('session.token_hash', '=', hashBearerToken(token))
        .executeTakeFirstOrThrow();
      await db
        .updateTable('session')
        .set({ expires_at: expiresAt })
        .where('session.id', '=', row.id)
        .execute();

      return { id: row.id, token };
    }

    async function expiryOf(id: string): Promise<Date | null> {
      const row = await db
        .selectFrom('session')
        .select('session.expires_at')
        .where('session.id', '=', id)
        .executeTakeFirst();
      return row ? new Date(row.expires_at) : null;
    }

    it('carries a session past the halfway mark forward on its next request', async () => {
      const { id, token } = await sessionExpiring(new Date(Date.now() + 10 * DAY_MS));

      expect((await anonymous.withToken(token).get('/api/auth/me')).status).toBe(200);

      // The write is unawaited by design, so the request answers before it
      // lands. A full TTL measured from now, not ten days and a bit: the clock
      // restarts rather than creeping forward by whatever was left.
      await vi.waitFor(
        async () => {
          expect((await expiryOf(id))?.getTime()).toBeGreaterThan(Date.now() + TTL_MS - 60_000);
        },
        { timeout: 5_000, interval: 25 }
      );
    });

    it('leaves a session still in the first half of its life alone', async () => {
      const expiresAt = new Date(Date.now() + TTL_MS - DAY_MS);
      const { id, token } = await sessionExpiring(expiresAt);

      expect((await anonymous.withToken(token).get('/api/auth/me')).status).toBe(200);

      // Not making the write is the behaviour, and a non-event cannot be waited
      // for: settle long enough that one issued in error would have landed.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect((await expiryOf(id))?.getTime()).toBe(expiresAt.getTime());
    });

    it('does not renew a session that has already lapsed', async () => {
      const { id, token } = await sessionExpiring(new Date(Date.now() - DAY_MS));

      expect((await anonymous.withToken(token).get('/api/auth/me')).status).toBe(401);

      expect(await expiryOf(id)).toBeNull();
    });
  });

  describe('password reset', () => {
    it('mails a link that sets a new password exactly once', async () => {
      const person = await createUser('reset');

      const requested = await anonymous.post('/api/auth/forgot-password', {
        email: person.email,
      });
      expect(requested.status).toBe(204);

      const mail = sentEmails().find((message) => message.to === person.email);
      expect(mail, 'a reset email should have been sent').toBeDefined();

      const token = /token=([^\s&]+)/.exec(mail!.text)?.[1];
      expect(token).toBeTypeOf('string');

      const reset = await anonymous.post('/api/auth/reset-password', {
        token: decodeURIComponent(token!),
        password: 'a brand new passphrase',
      });
      expect(reset.status).toBe(204);

      const login = await anonymous.post('/api/auth/login', {
        email: person.email,
        password: 'a brand new passphrase',
      });
      expect(login.status).toBe(200);

      // Rotating alternative_id is what makes the link single-use.
      const replay = await anonymous.post('/api/auth/reset-password', {
        token: decodeURIComponent(token!),
        password: 'yet another passphrase',
      });
      expect(replay.status).toBe(401);

      await deleteUser(person);
    });

    it('answers 404 for an address with no account', async () => {
      const res = await anonymous.post('/api/auth/forgot-password', {
        email: uniqueEmail('ghost'),
      });
      expect(res.status).toBe(404);
    });

    it('refuses a forged token', async () => {
      const res = await anonymous.post('/api/auth/reset-password', {
        token: 'bm90LWEtdG9rZW4.c2lnbmF0dXJl',
        password: 'a brand new passphrase',
      });
      expect(res.status).toBe(401);
    });
  });
});
