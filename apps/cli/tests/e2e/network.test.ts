import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { app } from '../../../api/src/index.ts';
import { createUser, deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { createCliHarness, pngBytes, type CliHarness } from './helpers.ts';

// The in-process harness hands the app a Request object and never serialises
// it, so a streamed upload body -- `duplex: 'half'` over undici -- and a
// streamed download are only exercised against a real socket. These are the
// commands that move bytes, sent the way the installed CLI sends them.
describe('transfers over a real connection', () => {
  let server: ReturnType<typeof serve>;
  let user: TestUser;
  let h: CliHarness;
  let projectId: string;

  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
        resolve(info.port)
      );
    });
    const apiUrl = `http://127.0.0.1:${String(port)}`;
    user = await createUser('cli-network');
    h = await createCliHarness(apiUrl, { network: true });
    await h.credentials.set(apiUrl, user.token);
    projectId = (await (await user.api.post('/api/projects', { name: 'Wire Game' })).json()).id;
    await mkdir(h.workDir, { recursive: true });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await deleteUser(user);
  });

  it('streams an upload up and the same bytes back down', async () => {
    // Several megabytes, so the body crosses many chunks in both directions.
    const bytes = randomBytes(5 * 1024 * 1024);
    const local = join(h.workDir, 'rulebook.bin');
    await writeFile(local, bytes);

    const up = await h.runCli(['upload', local, '--project', projectId]);
    expect(up.exitCode, up.stderr).toBe(0);

    const target = join(h.workDir, 'back.bin');
    const down = await h.runCli(['download', 'rulebook.bin', '-o', target, '--project', projectId]);
    expect(down.exitCode, down.stderr).toBe(0);
    expect((await readFile(target)).equals(bytes)).toBe(true);
  });

  it('appends a version over the wire and reads the older one back', async () => {
    const first = join(h.workDir, 'card.png');
    await writeFile(first, pngBytes(1));
    expect((await h.runCli(['upload', first, '--project', projectId])).exitCode).toBe(0);
    await writeFile(first, pngBytes(2));
    const pushed = await h.runCli(['file', 'push', 'card.png', first, '--project', projectId]);
    expect(pushed.stdout).toContain('is now version 2');

    const old = await h.runCli([
      'download',
      'card.png',
      '--version',
      '1',
      '-o',
      join(h.workDir, 'old.png'),
      '--project',
      projectId,
    ]);
    expect(old.exitCode, old.stderr).toBe(0);
    expect((await readFile(join(h.workDir, 'old.png'))).equals(pngBytes(1))).toBe(true);
  });

  // A viewer is refused before the server reads a byte of the body, while the
  // client is still streaming it; that has to arrive as the server's answer,
  // not as a connection torn down mid-upload.
  it('reports a refusal the server sends before it reads the body', async () => {
    const viewer = await createUser('cli-network-viewer');
    try {
      await user.api.put(`/api/projects/${projectId}/members`, {
        email: viewer.email,
        role: 'viewer',
      });
      const apiUrl = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
      const vh = await createCliHarness(apiUrl, { network: true });
      await vh.credentials.set(apiUrl, viewer.token);
      const local = join(h.workDir, 'large.bin');
      await writeFile(local, randomBytes(8 * 1024 * 1024));

      const res = await vh.runCli(['upload', local, '--project', projectId]);
      expect(res.exitCode, res.stderr).toBe(7);
    } finally {
      await deleteUser(viewer);
    }
  });

  it('reports a refusal the server sends once the bytes are up', async () => {
    const local = join(h.workDir, 'card.png');
    const res = await h.runCli(['upload', local, '--project', projectId]);
    expect(res.exitCode).toBe(5);
    expect(res.stderr).toContain('pass --replace');
  });
});
