import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createUser,
  deleteUser,
  uniqueEmail,
  type TestUser,
} from '../../../api/tests/setup/testContext.ts';
import { db } from '../../../api/src/db/index.ts';
import { API_URL, createCliHarness, type CliHarness } from './helpers.ts';

const PASSWORD = 'correct horse battery staple';

describe('signing in and out', () => {
  let user: TestUser;
  let h: CliHarness;

  beforeAll(async () => {
    user = await createUser('cli-auth');
    h = await createCliHarness();
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  it('login stores the token and whoami reads it back', async () => {
    const login = await h.runCli(['login', '--email', user.email, '--password-stdin'], {
      stdin: `${PASSWORD}\n`,
    });
    expect(login.exitCode).toBe(0);
    expect(login.stdout).toContain(`Signed in as ${user.name} <${user.email}>`);
    expect(await h.credentials.get(API_URL)).not.toBeNull();

    const whoami = await h.runCli(['whoami', '--json']);
    expect(whoami.exitCode).toBe(0);
    expect(whoami.json<{ email: string }>().email).toBe(user.email);
  });

  it('a wrong password exits 3 and names the server', async () => {
    const res = await h.runCli(['login', '--email', user.email, '--password-stdin'], {
      stdin: 'not the password\n',
    });
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain(`Invalid email or password for ${user.email} at ${API_URL}`);
  });

  it('a session created here is labelled with the CLI in the session list', async () => {
    const res = await h.runCli(['session', 'list', '--json']);
    expect(res.exitCode).toBe(0);
    const current = res
      .json<{ current: boolean; user_agent: string | null }[]>()
      .find((s) => s.current);
    expect(current?.user_agent).toMatch(/^threepeaks-cli\//);
  });

  it('refuses to prompt under --no-input', async () => {
    const res = await h.runCli(['login', '--no-input']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('--no-input');
  });

  it('logout ends the session on the server as well as forgetting it', async () => {
    const token = await h.credentials.get(API_URL);
    const res = await h.runCli(['logout']);
    expect(res.exitCode).toBe(0);
    expect(await h.credentials.get(API_URL)).toBeNull();

    const reuse = await h.runCli(['whoami'], { env: { THREEPEAKS_TOKEN: token ?? '' } });
    expect(reuse.exitCode).toBe(3);
    expect(reuse.stderr).toContain('Run: threepeaks login');
  });

  it('whoami without a credential exits 3 with the login hint', async () => {
    const res = await h.runCli(['whoami']);
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('threepeaks login');
  });
});

describe('signing up', () => {
  const email = uniqueEmail('cli-signup');

  afterAll(async () => {
    await db.deleteFrom('app_user').where('app_user.email', '=', email).execute();
  });

  it('creates the account and signs straight in', async () => {
    const h = await createCliHarness();
    const res = await h.runCli(
      ['signup', '--email', email, '--name', 'New Designer', '--password-stdin'],
      { stdin: `${PASSWORD}\n` }
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Signed up as New Designer');

    const whoami = await h.runCli(['whoami', '--json']);
    expect(whoami.json<{ name: string }>().name).toBe('New Designer');
  });

  it('a second account on the same address is a conflict', async () => {
    const h = await createCliHarness();
    const res = await h.runCli(
      ['signup', '--email', email, '--name', 'Again', '--password-stdin'],
      { stdin: `${PASSWORD}\n` }
    );
    expect(res.exitCode).toBe(5);
  });
});

describe('the account', () => {
  let user: TestUser;
  let h: CliHarness;

  beforeAll(async () => {
    user = await createUser('cli-account');
    h = await createCliHarness();
    await h.credentials.set(API_URL, user.token);
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  it('change-password takes the current then the new password and keeps the session', async () => {
    const res = await h.runCli(['account', 'change-password', '--password-stdin'], {
      stdin: `${PASSWORD}\na brand new passphrase\n`,
    });
    expect(res.exitCode).toBe(0);
    expect((await h.runCli(['whoami'])).exitCode).toBe(0);

    const fresh = await createCliHarness();
    const login = await fresh.runCli(['login', '--email', user.email, '--password-stdin'], {
      stdin: 'a brand new passphrase\n',
    });
    expect(login.exitCode).toBe(0);
  });

  it('a wrong current password is exit 3 without the login hint', async () => {
    const res = await h.runCli(['account', 'change-password', '--password-stdin'], {
      stdin: 'wrong\nwhatever passphrase\n',
    });
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('Incorrect current password');
    expect(res.stderr).not.toContain('threepeaks login');
  });

  it('forgot-password answers 404 for an address with no account', async () => {
    const res = await h.runCli(['account', 'forgot-password', '--email', uniqueEmail('nobody')]);
    expect(res.exitCode).toBe(4);
  });

  it('forgot-password sends for a real address', async () => {
    const res = await h.runCli(['account', 'forgot-password', '--email', user.email, '--json']);
    expect(res.exitCode).toBe(0);
    expect(res.json()).toEqual({ sent: true });
  });

  it('reset-password refuses a token that is not one', async () => {
    const res = await h.runCli(
      ['account', 'reset-password', '--token', 'forged', '--password-stdin'],
      { stdin: 'another passphrase\n' }
    );
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toContain('invalid or has expired');
  });
});

describe('sessions', () => {
  let user: TestUser;
  let h: CliHarness;

  beforeAll(async () => {
    user = await createUser('cli-sessions');
    h = await createCliHarness();
    await h.runCli(['login', '--email', user.email, '--password-stdin'], {
      stdin: `${PASSWORD}\n`,
    });
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  it('lists every session and marks this one', async () => {
    const res = await h.runCli(['session', 'list', '--json']);
    const sessions = res.json<{ id: string; current: boolean }[]>();
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
  });

  it('revokes another session by id prefix and leaves this one signed in', async () => {
    const sessions = (await h.runCli(['session', 'list', '--json'])).json<
      { id: string; current: boolean }[]
    >();
    const other = sessions.find((s) => !s.current)!;

    const res = await h.runCli(['session', 'revoke', other.id.slice(0, 8), '--force']);
    expect(res.exitCode).toBe(0);
    expect((await user.api.get('/api/auth/me')).status).toBe(401);
    expect((await h.runCli(['whoami'])).exitCode).toBe(0);
  });

  it('revoking the current session signs the CLI out', async () => {
    const sessions = (await h.runCli(['session', 'list', '--json'])).json<
      { id: string; current: boolean }[]
    >();
    const current = sessions.find((s) => s.current)!;

    const res = await h.runCli(['session', 'revoke', current.id, '--force']);
    expect(res.exitCode).toBe(0);
    expect(await h.credentials.get(API_URL)).toBeNull();
  });
});

describe('status', () => {
  let user: TestUser;

  beforeAll(async () => {
    user = await createUser('cli-status');
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  it('names the server, its build and the account', async () => {
    const h = await createCliHarness();
    await h.credentials.set(API_URL, user.token);
    const res = await h.runCli(['status', '--json']);
    expect(res.exitCode).toBe(0);
    const report = res.json<{
      api_url: string;
      health: { status: string; name: string };
      user: { email: string } | null;
      token_source: string;
    }>();
    expect(report.api_url).toBe(API_URL);
    expect(report.health).toMatchObject({ status: 'ok', name: 'three-peaks-hub' });
    expect(report.user?.email).toBe(user.email);
    expect(report.token_source).toBe('stored');
  });

  it('still answers when nobody is signed in', async () => {
    const h = await createCliHarness();
    const res = await h.runCli(['status']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('not signed in');
  });
});
