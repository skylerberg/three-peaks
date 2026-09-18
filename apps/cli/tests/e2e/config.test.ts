import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteUser } from '../../../api/tests/setup/testContext.ts';
import { signedInHarness, type CliHarness } from './helpers.ts';
import type { TestUser } from '../../../api/tests/setup/testContext.ts';

describe('config', () => {
  let h: CliHarness;
  let user: TestUser;
  let projectId: string;

  beforeAll(async () => {
    ({ h, user } = await signedInHarness('cli-config'));
    projectId = (await (await user.api.post('/api/projects', { name: 'Configured Game' })).json())
      .id;
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  it('stores the default project as its id, so a rename does not break it', async () => {
    const res = await h.runCli(['config', 'set', 'default-project', 'Configured Game']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(`default-project = ${projectId}`);

    await user.api.patch(`/api/projects/${projectId}`, { name: 'Renamed Game' });
    const got = await h.runCli(['config', 'get', 'default-project']);
    expect(got.stdout.trim()).toBe(projectId);
  });

  it('refuses a default project that names nothing', async () => {
    const res = await h.runCli(['config', 'set', 'default-project', 'No Such Game']);
    expect(res.exitCode).toBe(4);
  });

  it('normalises a base URL and refuses one that cannot precede a path', async () => {
    const ok = await h.runCli(['config', 'set', 'web-url', 'https://example.com/hub/']);
    expect(ok.stdout.trim()).toBe('web-url = https://example.com/hub');

    const bad = await h.runCli(['config', 'set', 'api-url', 'https://user:pw@example.com']);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain('no query, fragment or credentials');
  });

  it('unset removes a key and get with no key prints the rest', async () => {
    await h.runCli(['config', 'unset', 'web-url']);
    const all = await h.runCli(['config', 'get', '--json']);
    expect(all.json()).toEqual({ default_project: projectId });
  });

  it('names where a stale default project came from', async () => {
    await mkdir(h.configDir, { recursive: true });
    const path = join(h.configDir, 'config.json');
    const stored = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...stored, default_project: 'Gone Game' }));

    const res = await h.runCli(['project', 'show']);
    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain('it is the default-project in');
  });

  it('an unknown key is a usage error listing the real ones', async () => {
    const res = await h.runCli(['config', 'set', 'colour', 'blue']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('valid keys: api-url, default-project, web-url');
  });
});
