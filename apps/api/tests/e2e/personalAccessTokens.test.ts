import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  MAX_PERSONAL_ACCESS_TOKENS_PER_USER,
  PERSONAL_ACCESS_TOKEN_PREFIX,
} from '@three-peaks/shared';
import { db } from '../../src/db/index.ts';
import { anonymous, createUser, deleteUser, type TestUser } from '../setup/testContext.ts';

interface TokenRow {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

describe('personal access tokens', () => {
  let user: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    user = await createUser('pat');
    other = await createUser('pat-other');
  });

  afterAll(async () => {
    await deleteUser(user);
    await deleteUser(other);
  });

  async function create(name: string, owner = user) {
    const res = await owner.api.post('/api/auth/tokens', { name });
    expect(res.status).toBe(201);
    return (await res.json()) as { token: string; personal_access_token: TokenRow };
  }

  async function list(owner = user): Promise<TokenRow[]> {
    const res = await owner.api.get('/api/auth/tokens');
    expect(res.status).toBe(200);
    return (await res.json()).personal_access_tokens;
  }

  it('creates a token whose secret authenticates as the account', async () => {
    const created = await create('deploy script');
    expect(created.token.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(created.personal_access_token.name).toBe('deploy script');
    expect(created.personal_access_token.last_used_at).toBeNull();

    const me = await anonymous.withToken(created.token).get('/api/auth/me');
    expect(me.status).toBe(200);
    expect((await me.json()).id).toBe(user.id);
  });

  it('lists tokens newest first and never includes a secret', async () => {
    const first = await create('first');
    const second = await create('second');

    const res = await user.api.get('/api/auth/tokens');
    const text = await res.text();
    expect(text).not.toContain(first.token);
    expect(text).not.toContain(second.token);

    const ids = (JSON.parse(text).personal_access_tokens as TokenRow[]).map((t) => t.id);
    expect(ids.indexOf(second.personal_access_token.id)).toBeLessThan(
      ids.indexOf(first.personal_access_token.id)
    );
    expect(await list(other)).toEqual([]);
  });

  it('records when a token was last used', async () => {
    const created = await create('used');
    expect((await anonymous.withToken(created.token).get('/api/auth/me')).status).toBe(200);

    // The write is deliberately off the request's transaction and not awaited,
    // so it is polled for rather than read back at once.
    let row: TokenRow | undefined;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      row = (await list()).find((t) => t.id === created.personal_access_token.id);
      if (row?.last_used_at) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(row?.last_used_at).not.toBeNull();
  });

  it('revokes a token, which then stops authenticating', async () => {
    const created = await create('short-lived');
    const res = await user.api.delete(`/api/auth/tokens/${created.personal_access_token.id}`);
    expect(res.status).toBe(204);

    expect((await anonymous.withToken(created.token).get('/api/auth/me')).status).toBe(401);
    expect((await list()).map((t) => t.id)).not.toContain(created.personal_access_token.id);
  });

  it("answers 404 for another account's token and leaves it working", async () => {
    const theirs = await create('theirs', other);
    const res = await user.api.delete(`/api/auth/tokens/${theirs.personal_access_token.id}`);
    expect(res.status).toBe(404);
    expect((await anonymous.withToken(theirs.token).get('/api/auth/me')).status).toBe(200);
  });

  it('answers 404 for a token that does not exist', async () => {
    expect((await user.api.delete(`/api/auth/tokens/${randomUUID()}`)).status).toBe(404);
  });

  it('refuses a duplicate id with 409', async () => {
    const id = randomUUID();
    expect((await user.api.post('/api/auth/tokens', { id, name: 'one' })).status).toBe(201);
    expect((await user.api.post('/api/auth/tokens', { id, name: 'two' })).status).toBe(409);
  });

  it('refuses a blank name', async () => {
    expect((await user.api.post('/api/auth/tokens', { name: '   ' })).status).toBe(422);
  });

  it('is available to an account signed in with a token', async () => {
    const created = await create('bootstrap');
    const res = await anonymous.withToken(created.token).post('/api/auth/tokens', {
      name: 'minted by a token',
    });
    expect(res.status).toBe(201);
  });

  it('caps how many tokens one account holds', async () => {
    const capped = await createUser('pat-cap');
    try {
      await db
        .insertInto('personal_access_token')
        .values(
          Array.from({ length: MAX_PERSONAL_ACCESS_TOKENS_PER_USER }, (_, i) => ({
            id: randomUUID(),
            user_id: capped.id,
            name: `bulk ${i}`,
            token_hash: randomUUID(),
          }))
        )
        .execute();

      const res = await capped.api.post('/api/auth/tokens', { name: 'one too many' });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toContain(String(MAX_PERSONAL_ACCESS_TOKENS_PER_USER));
    } finally {
      await deleteUser(capped);
    }
  });

  it('refuses every route without a credential', async () => {
    expect((await anonymous.get('/api/auth/tokens')).status).toBe(401);
    expect((await anonymous.post('/api/auth/tokens', { name: 'x' })).status).toBe(401);
    expect((await anonymous.delete(`/api/auth/tokens/${randomUUID()}`)).status).toBe(401);
  });
});
