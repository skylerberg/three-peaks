import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { components } from '@three-peaks/shared/api';
import { PERSONAL_ACCESS_TOKEN_PREFIX } from '@three-peaks/shared';
import { deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { signedInHarness, type CliHarness } from './helpers.ts';

type Created = components['schemas']['CreatedPersonalAccessToken'];
type Token = components['schemas']['PersonalAccessTokenList']['personal_access_tokens'][number];

describe('token commands', () => {
  let h: CliHarness;
  let user: TestUser;

  beforeAll(async () => {
    ({ h, user } = await signedInHarness('cli-token'));
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  it('create prints the secret alone on stdout, and it authenticates', async () => {
    const res = await h.runCli(['token', 'create', 'agent']);
    expect(res.exitCode).toBe(0);
    const secret = res.stdout.trim();
    expect(secret.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(res.stdout).toBe(`${secret}\n`);
    expect(res.stderr).toContain('only time the secret is shown');
    expect(res.stderr).not.toContain(secret);

    // A fresh harness holds no session, so the token is the only credential.
    const list = await h.runCli(['token', 'list', '--json'], {
      env: { THREEPEAKS_TOKEN: secret },
    });
    expect(list.exitCode).toBe(0);
    expect(list.json<Token[]>().map((t) => t.name)).toContain('agent');
  });

  it('create --json carries the secret and the row', async () => {
    const res = await h.runCli(['token', 'create', 'ci', '--json']);
    expect(res.exitCode).toBe(0);
    const created = res.json<Created>();
    expect(created.token.startsWith(PERSONAL_ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(created.personal_access_token.name).toBe('ci');
  });

  it('list shows names and when each was last used, never a secret', async () => {
    const created = (await h.runCli(['token', 'create', 'listed', '--json'])).json<Created>();
    const res = await h.runCli(['token', 'list']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('listed');
    expect(res.stdout).toContain('LAST USED');
    expect(res.stdout).not.toContain(created.token);
  });

  it('revoke asks first, and refuses to guess under --no-input', async () => {
    await h.runCli(['token', 'create', 'doomed']);
    const refused = await h.runCli(['token', 'revoke', 'doomed', '--no-input']);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('--force');

    const declined = await h.runCli(['token', 'revoke', 'doomed'], { stdin: 'n\n' });
    expect(declined.exitCode).toBe(1);
    const still = (await h.runCli(['token', 'list', '--json'])).json<Token[]>();
    expect(still.map((t) => t.name)).toContain('doomed');
  });

  it('revoke by name stops the token authenticating', async () => {
    const created = (await h.runCli(['token', 'create', 'revoked', '--json'])).json<Created>();
    const res = await h.runCli(['token', 'revoke', 'revoked', '--force']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Revoked token revoked');

    const after = await h.runCli(['token', 'list'], { env: { THREEPEAKS_TOKEN: created.token } });
    expect(after.exitCode).toBe(3);
  });

  it('revoke by id prefix works, and an unknown name is exit 4', async () => {
    const created = (await h.runCli(['token', 'create', 'prefixed', '--json'])).json<Created>();
    const res = await h.runCli([
      'token',
      'revoke',
      created.personal_access_token.id.slice(0, 8),
      '--force',
      '--json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(res.json<{ id: string }>().id).toBe(created.personal_access_token.id);

    const missing = await h.runCli(['token', 'revoke', 'no-such-token', '--force']);
    expect(missing.exitCode).toBe(4);
  });
});
