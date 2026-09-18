import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../../api/src/index.ts';
import { attachRealtime } from '../../../api/src/services/realtime/index.ts';
import { resetConnectionsForTests } from '../../../api/src/services/realtime/state.ts';
import {
  anonymous,
  createUser,
  deleteUser,
  type TestUser,
} from '../../../api/tests/setup/testContext.ts';
import { createCliHarness, type CliHarness, type CliRunHandle } from './helpers.ts';

interface EventLine {
  type: string;
  project_id: string;
  data: Record<string, unknown>;
}

function eventLines(handle: CliRunHandle): EventLine[] {
  return handle
    .output()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as EventLine);
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// The socket cannot ride the harness's in-process fetch, so this file serves the
// app on a real port. Every other request still goes in-process; only the
// WebSocket travels over it.
describe('watch', () => {
  let server: ReturnType<typeof serve>;
  let detach: () => void;
  let apiUrl: string;
  let user: TestUser;
  let h: CliHarness;
  let alpha: string;
  let beta: string;

  // Subscribing happens after the server says ready, which the command does not
  // announce; a folder created before then would reach nobody.
  async function started(argv: string[]): Promise<CliRunHandle> {
    const handle = h.startCli(['watch', ...argv]);
    await waitFor(() => handle.errorOutput().includes('Watching'), 'the watch to start');
    await new Promise((resolve) => setTimeout(resolve, 300));
    return handle;
  }

  async function createFolder(projectId: string, name: string): Promise<void> {
    const res = await user.api.post('/api/files/folders', { project_id: projectId, name });
    expect(res.status).toBe(201);
  }

  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
        resolve(info.port)
      );
    });
    detach = attachRealtime(server as unknown as Server);
    apiUrl = `http://127.0.0.1:${String(port)}`;

    user = await createUser('cli-watch');
    h = await createCliHarness(apiUrl);
    await h.credentials.set(apiUrl, user.token);
    alpha = (await (await user.api.post('/api/projects', { name: 'Watch Alpha' })).json()).id;
    beta = (await (await user.api.post('/api/projects', { name: 'Watch Beta' })).json()).id;
  });

  afterAll(async () => {
    detach();
    resetConnectionsForTests();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await deleteUser(user);
  });

  it('streams every project as NDJSON on stdout and diagnostics on stderr', async () => {
    const handle = await started([]);
    await createFolder(alpha, 'From Alpha');
    await createFolder(beta, 'From Beta');
    await waitFor(() => eventLines(handle).length >= 2, 'two events');

    handle.interrupt();
    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    const events = eventLines(handle);
    expect(events.map((e) => e.project_id).sort()).toEqual([alpha, beta].sort());
    expect(events.every((e) => e.type === 'folder_created')).toBe(true);
    expect(result.stderr).toContain('Watching 2 project(s)');
  });

  it('narrows to one project with --project', async () => {
    const handle = await started(['--project', 'Watch Alpha']);
    await createFolder(beta, 'Unseen');
    await createFolder(alpha, 'Seen');
    await waitFor(() => eventLines(handle).length >= 1, 'the alpha event');
    await new Promise((resolve) => setTimeout(resolve, 200));

    handle.interrupt();
    await handle.done;
    expect(eventLines(handle).map((e) => e.data.name)).toEqual(['Seen']);
  });

  it('exits 3 once the session it runs on is signed out elsewhere', async () => {
    const signedIn = await (
      await anonymous.post('/api/auth/login', {
        email: user.email,
        password: 'correct horse battery staple',
      })
    ).json();
    const second = await createCliHarness(apiUrl);
    await second.credentials.set(apiUrl, signedIn.token);
    const { sessions } = await (
      await user.api.withToken(signedIn.token).get('/api/auth/sessions')
    ).json();
    const sessionId = sessions.find((s: { current: boolean }) => s.current).id;

    const handle = second.startCli(['watch', '--project', 'Watch Alpha']);
    await waitFor(() => handle.errorOutput().includes('Watching'), 'the watch to start');
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect((await user.api.delete(`/api/auth/sessions/${sessionId}`)).status).toBe(204);
    await createFolder(alpha, 'After Sign Out');

    const result = await handle.done;
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('credential was revoked');
    expect(eventLines(handle)).toEqual([]);
  });

  it('refuses to start without a credential', async () => {
    const anon = await createCliHarness(apiUrl);
    const result = await anon.runCli(['watch', '--project', alpha]);
    expect(result.exitCode).toBe(3);
  });
});
