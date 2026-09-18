import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { components } from '@three-peaks/shared/api';
import { db } from '../../../api/src/db/index.ts';
import { recordAppBuild, startPairing } from '../../../api/src/services/canvaApp.ts';
import { deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { createCliHarness, signedInHarness, type CliHarness } from './helpers.ts';

type CanvaLink = components['schemas']['CanvaAppLink'];

const BRAND = 'AYTuhKSpgCUG1Ddz5RPmGYGe3nXTr-cli-brand';

describe('canva commands', () => {
  let h: CliHarness;
  let user: TestUser;
  let pairings = 0;

  beforeAll(async () => {
    ({ h, user } = await signedInHarness('cli-canva'));
  });

  afterEach(async () => {
    await db.deleteFrom('canva_app_pairing').execute();
    await db.deleteFrom('canva_app_link').execute();
    await db.deleteFrom('canva_app_build').execute();
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  // What the app does when somebody who is not linked opens it; minted here
  // directly, because the route that does it verifies a Canva-signed JWT.
  async function pairingCode(): Promise<string> {
    pairings += 1;
    const { code } = await startPairing(db, {
      canvaUserId: `cli-canva-user-${String(pairings)}`,
      canvaBrandId: BRAND,
    });
    return code;
  }

  it('pair spends the code, and the code is case- and hyphen-insensitive', async () => {
    const code = await pairingCode();
    const typed = code.replace('-', '').toLowerCase();
    const res = await h.runCli(['canva', 'pair', typed]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('Linked the Canva app');

    const links = await h.runCli(['canva', 'links', '--json']);
    expect(links.json<CanvaLink[]>()).toHaveLength(1);
    expect(links.json<CanvaLink[]>()[0].canva_brand_id).toBe(BRAND);
  });

  it('a spent or invented code is exit 4 with the reason', async () => {
    const code = await pairingCode();
    expect((await h.runCli(['canva', 'pair', code])).exitCode).toBe(0);
    const spent = await h.runCli(['canva', 'pair', code]);
    expect(spent.exitCode).toBe(4);
    expect(spent.stderr).toContain('That code is not valid');
    expect((await h.runCli(['canva', 'pair', 'ZZZZ-9999'])).exitCode).toBe(4);
  });

  it('links lists nothing until something is linked', async () => {
    const res = await h.runCli(['canva', 'links']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('No Canva accounts are linked');
  });

  it('unlink removes a link by id prefix after confirming', async () => {
    const link = (
      await h.runCli(['canva', 'pair', await pairingCode(), '--json'])
    ).json<CanvaLink>();
    const prefix = link.id.slice(0, 8);

    expect((await h.runCli(['canva', 'unlink', prefix, '--no-input'])).exitCode).toBe(2);
    const res = await h.runCli(['canva', 'unlink', prefix, '--force']);
    expect(res.exitCode).toBe(0);
    expect((await h.runCli(['canva', 'links', '--json'])).json<CanvaLink[]>()).toEqual([]);
  });

  it('build says plainly when no build has reported', async () => {
    const res = await h.runCli(['canva', 'build']);
    expect(res.exitCode).toBe(4);
    expect(res.stderr).toContain('No Canva app build has reported yet');
  });

  it('build names the newest build and needs no session', async () => {
    await recordAppBuild(db, {
      commit: 'abc1234',
      branch: 'main',
      dirty: false,
      built_at: '2026-09-01T12:00:00.000Z',
    });
    await recordAppBuild(db, {
      commit: 'def5678',
      branch: 'main',
      dirty: true,
      built_at: '2026-09-02T12:00:00.000Z',
    });
    // Two reports inside one millisecond would tie on last_seen_at.
    await db
      .updateTable('canva_app_build')
      .set({ last_seen_at: new Date(Date.now() - 60 * 60 * 1000) })
      .where('commit', '=', 'abc1234')
      .execute();

    const anonymous = await createCliHarness();
    const res = await anonymous.runCli(['canva', 'build']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/Commit:\s+def5678 \(built from a dirty tree\)/);
    expect(res.stdout).toMatch(/Branch:\s+main/);

    const json = await anonymous.runCli(['canva', 'build', '--json']);
    expect(json.json<{ commit: string }>().commit).toBe('def5678');
  });
});
