import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { db } from '../../src/db/index.ts';
import { resetCanvaKeySets } from '../../src/services/canvaApp.ts';
import { anonymous, createUser, deleteUser, type TestUser } from '../setup/testContext.ts';

const APP_ID = 'AAHtestAppId';
const OTHER_APP_ID = 'AAHsomeoneElse';
const CANVA_USER = 'AYTuhKSvIa8CTfcvm9PPul9a9ilJri1Xl88mE2BdGIA=';
const BRAND = 'AYTuhKSpgCUG1Ddz5RPmGYGe3nXTr-l9ZhVUfAbyl0E=';

// Canva's JWKS stood up locally. Nothing here reaches the network: the fetch
// jose would make is answered from this key set, which is also what lets a test
// mint a token signed by the WRONG key and watch it be refused -- the one case
// that cannot be written against the real endpoint.
let privateKey: CryptoKey;
let jwks: { keys: unknown[] };
let strangerKey: CryptoKey;
const realFetch = globalThis.fetch;

async function mintToken(
  overrides: {
    audience?: string;
    userId?: string | null;
    brandId?: string | null;
    expiresIn?: string;
    key?: CryptoKey;
  } = {}
): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (overrides.userId !== null) claims['userId'] = overrides.userId ?? CANVA_USER;
  if (overrides.brandId !== null) claims['brandId'] = overrides.brandId ?? BRAND;

  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setAudience(overrides.audience ?? APP_ID)
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .sign(overrides.key ?? privateKey);
}

function session(token: string, switchAccount = false) {
  return anonymous.post('/api/canva-app/session', {
    token,
    ...(switchAccount ? { switch_account: true } : {}),
  });
}

describe('the Canva app', () => {
  let owner: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256' }] };
    strangerKey = (await generateKeyPair('RS256', { extractable: true })).privateKey;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('api.canva.com')) {
        return new Response(JSON.stringify(jwks), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return await realFetch(input, init);
    }) as typeof fetch;

    process.env.CANVA_APP_ID = APP_ID;
    owner = await createUser('canva-owner');
    other = await createUser('canva-other');
  });

  afterEach(async () => {
    await db.deleteFrom('canva_app_pairing').execute();
    await db.deleteFrom('canva_app_link').execute();
    await db.deleteFrom('canva_app_build').execute();
    resetCanvaKeySets();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.CANVA_APP_ID;
    await deleteUser(owner);
    await deleteUser(other);
  });

  async function pairingCode(switchAccount = false): Promise<string> {
    const res = await session(await mintToken(), switchAccount);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.linked).toBe(false);
    return body.pairing_code as string;
  }

  describe('a token this server will not take', () => {
    it('refuses one signed by a key that is not Canva’s', async () => {
      const res = await session(await mintToken({ key: strangerKey }));
      expect(res.status).toBe(401);
    });

    // The check that stops any other app on Canva authenticating here. Its
    // token is signed by a real Canva key, so the signature alone proves
    // nothing about which app asked for it.
    it('refuses one issued to another app', async () => {
      const res = await session(await mintToken({ audience: OTHER_APP_ID }));
      expect(res.status).toBe(401);
    });

    it('refuses one that has expired', async () => {
      const res = await session(await mintToken({ expiresIn: '-1m' }));
      expect(res.status).toBe(401);
    });

    it('refuses one naming no user', async () => {
      const res = await session(await mintToken({ userId: null }));
      expect(res.status).toBe(401);
    });

    it('says the same thing about every one of them', async () => {
      const bodies = await Promise.all(
        [
          await mintToken({ key: strangerKey }),
          await mintToken({ audience: OTHER_APP_ID }),
          await mintToken({ expiresIn: '-1m' }),
        ].map(async (token) => (await (await session(token)).json()).error)
      );
      expect(new Set(bodies).size).toBe(1);
    });
  });

  describe('a Canva user nobody has linked', () => {
    it('answers 200 with a code rather than refusing', async () => {
      const res = await session(await mintToken());
      expect(res.status).toBe(200);
      const body = await res.json();
      // A valid token belonging to a stranger is not an authentication
      // failure -- there is somewhere for them to go, and this is it.
      expect(body).toMatchObject({ linked: false });
      expect(body.pairing_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
      expect(body.token).toBeUndefined();
    });

    it('replaces the live code when the app asks again', async () => {
      const first = await pairingCode();
      const second = await pairingCode();
      expect(second).not.toBe(first);

      expect((await owner.api.post('/api/canva-app/pair', { code: first })).status).toBe(404);
      expect((await owner.api.post('/api/canva-app/pair', { code: second })).status).toBe(201);
    });
  });

  describe('spending a code', () => {
    it('links the account and hands the app a session it can use', async () => {
      const code = await pairingCode();
      expect((await owner.api.post('/api/canva-app/pair', { code })).status).toBe(201);

      const res = await session(await mintToken());
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ linked: true });
      expect(body.user.id).toBe(owner.id);

      // The whole point of answering with an ordinary session: the app gets the
      // existing API rather than a surface of its own.
      const projects = await anonymous.withToken(body.token).get('/api/projects');
      expect(projects.status).toBe(200);
    });

    it('accepts the code lower-cased and without its hyphen', async () => {
      const code = await pairingCode();
      const typed = code.toLowerCase().replace('-', '');
      expect((await owner.api.post('/api/canva-app/pair', { code: typed })).status).toBe(201);
    });

    it('refuses a second spend of one code', async () => {
      const code = await pairingCode();
      expect((await owner.api.post('/api/canva-app/pair', { code })).status).toBe(201);
      expect((await other.api.post('/api/canva-app/pair', { code })).status).toBe(404);
    });

    it('answers a code nobody issued the same way as a spent one', async () => {
      const code = await pairingCode();
      expect((await owner.api.post('/api/canva-app/pair', { code })).status).toBe(201);

      const spent = await owner.api.post('/api/canva-app/pair', { code });
      const invented = await owner.api.post('/api/canva-app/pair', { code: 'ZZZZ-9999' });
      expect(spent.status).toBe(404);
      expect(invented.status).toBe(404);
      expect((await spent.json()).error).toBe((await invented.json()).error);
    });

    it('refuses an expired code', async () => {
      const code = await pairingCode();
      await db
        .updateTable('canva_app_pairing')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .execute();
      expect((await owner.api.post('/api/canva-app/pair', { code })).status).toBe(404);
    });

    it('needs a session of ours, and refuses an anonymous caller', async () => {
      const code = await pairingCode();
      expect((await anonymous.post('/api/canva-app/pair', { code })).status).toBe(401);
    });
  });

  describe('a link somebody wants back', () => {
    it('lists and revokes, and the app falls back to asking again', async () => {
      const code = await pairingCode();
      expect((await owner.api.post('/api/canva-app/pair', { code })).status).toBe(201);
      expect((await session(await mintToken())).status).toBe(200);

      const listed = await owner.api.get('/api/canva-app/links');
      expect(listed.status).toBe(200);
      const links = (await listed.json()).links as { id: string; last_used_at: string | null }[];
      expect(links).toHaveLength(1);
      // Stamped by the exchange above, which is the only thing that tells a
      // link somebody is using from one they set up and forgot.
      expect(links[0].last_used_at).not.toBeNull();

      expect((await owner.api.delete(`/api/canva-app/links/${links[0].id}`)).status).toBe(204);

      const after = await session(await mintToken());
      expect((await after.json()).linked).toBe(false);
    });

    it('answers 404 for a link belonging to somebody else', async () => {
      const code = await pairingCode();
      expect((await owner.api.post('/api/canva-app/pair', { code })).status).toBe(201);
      const links = (await (await owner.api.get('/api/canva-app/links')).json()).links as {
        id: string;
      }[];

      expect((await other.api.delete(`/api/canva-app/links/${links[0].id}`)).status).toBe(404);
      expect((await owner.api.get('/api/canva-app/links')).status).toBe(200);
    });

    it('moves a Canva login to whichever account last spent a code for it', async () => {
      expect(
        (await owner.api.post('/api/canva-app/pair', { code: await pairingCode() })).status
      ).toBe(201);

      // Already linked, so the exchange would hand back a session. Asking to
      // switch is the only way somebody signed into the wrong account can say
      // so without leaving Canva.
      const code = await pairingCode(true);
      expect((await other.api.post('/api/canva-app/pair', { code })).status).toBe(201);

      const body = await (await session(await mintToken())).json();
      expect(body.user.id).toBe(other.id);
      expect((await (await owner.api.get('/api/canva-app/links')).json()).links).toHaveLength(0);
    });

    it('leaves the old link working until a switch code is actually spent', async () => {
      expect(
        (await owner.api.post('/api/canva-app/pair', { code: await pairingCode() })).status
      ).toBe(201);
      await pairingCode(true);

      // The code is out but nobody has spent it, so the link it would replace
      // is still the answer.
      const body = await (await session(await mintToken())).json();
      expect(body.linked).toBe(true);
      expect(body.user.id).toBe(owner.id);
    });
  });

  // The bundle goes into the Developer Portal by hand and Canva exposes no API
  // that reads it back, so what a running bundle says about itself is the only
  // evidence of what is up there.
  describe('the build the portal is serving', () => {
    const build = {
      commit: 'a01280bfb040',
      branch: 'main',
      dirty: false,
      built_at: '2026-09-17T12:00:00.000Z',
    };
    const anHourAgo = () => new Date(Date.now() - 3_600_000);

    async function reported(overrides: Partial<typeof build> = {}) {
      const res = await anonymous.post('/api/canva-app/session', {
        token: await mintToken(),
        build: { ...build, ...overrides },
      });
      expect(res.status).toBe(200);
      return res;
    }

    async function deployed() {
      const res = await anonymous.get('/api/canva-app/build');
      expect(res.status).toBe(200);
      return await res.json();
    }

    it('answers 404 until a bundle has reported one', async () => {
      expect((await anonymous.get('/api/canva-app/build')).status).toBe(404);
    });

    it('records what a running bundle said, and tells anyone who asks', async () => {
      await reported();
      const body = await deployed();
      expect(body.commit).toBe(build.commit);
      expect(body.branch).toBe('main');
      expect(body.dirty).toBe(false);
      expect(new Date(body.built_at).toISOString()).toBe(build.built_at);
    });

    // The bundle that was in the portal when this shipped carries nothing to
    // report, and that is a state the record has to be able to be in.
    it('records nothing for an exchange that carries no build', async () => {
      const res = await anonymous.post('/api/canva-app/session', { token: await mintToken() });
      expect(res.status).toBe(200);
      expect((await anonymous.get('/api/canva-app/build')).status).toBe(404);
    });

    // The report is written before the answer branches: a bundle is running
    // whether or not the person in front of it has been linked to an account.
    it('records one from an app nobody has paired yet', async () => {
      expect((await (await reported()).json()).linked).toBe(false);
      expect((await deployed()).commit).toBe(build.commit);
    });

    it('keeps when a build first appeared while moving when it was last seen', async () => {
      await reported();
      const earlier = anHourAgo();
      await db
        .updateTable('canva_app_build')
        .set({ first_seen_at: earlier, last_seen_at: earlier })
        .execute();

      await reported();
      const body = await deployed();
      expect(new Date(body.first_seen_at).getTime()).toBe(earlier.getTime());
      expect(new Date(body.last_seen_at).getTime()).toBeGreaterThan(earlier.getTime());
    });

    it('answers with the build seen most recently, which is the one up there', async () => {
      await reported({ commit: 'older00000000' });
      // Backdated rather than raced. Two exchanges can land inside one
      // millisecond, and what is under test is the ordering, not the clock.
      await db.updateTable('canva_app_build').set({ last_seen_at: anHourAgo() }).execute();

      await reported({ commit: 'newer11111111' });
      expect((await deployed()).commit).toBe('newer11111111');
    });

    it('refuses a build whose timestamp is not a timestamp', async () => {
      const res = await anonymous.post('/api/canva-app/session', {
        token: await mintToken(),
        build: { ...build, built_at: 'the other day' },
      });
      expect(res.status).toBe(422);
    });
  });
});
