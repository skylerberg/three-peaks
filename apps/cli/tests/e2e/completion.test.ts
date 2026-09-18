import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteUser, type TestUser } from '../../../api/tests/setup/testContext.ts';
import { pngBytes, signedInHarness, type CliHarness } from './helpers.ts';

function values(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t')[0]);
}

describe('completion', () => {
  let h: CliHarness;
  let user: TestUser;
  let projectId: string;

  async function complete(line: string): Promise<string[]> {
    const res = await h.runCli(['__complete', '--', ...line.split(' ')]);
    expect(res.exitCode).toBe(0);
    return values(res.stdout);
  }

  beforeAll(async () => {
    ({ h, user } = await signedInHarness('cli-complete'));
    projectId = (await (await user.api.post('/api/projects', { name: 'Completed Game' })).json())
      .id;
    const deck = await (
      await user.api.post('/api/decks', {
        project_id: projectId,
        name: 'Heroes',
        card_width_mm: 63,
        card_height_mm: 88,
      })
    ).json();
    await user.api.postBytes(
      `/api/files/upload?project_id=${projectId}&deck_id=${deck.id}&filename=knight.png`,
      pngBytes(1) as unknown as BodyInit
    );
    const art = await (
      await user.api.post('/api/files/folders', { project_id: projectId, name: 'Art' })
    ).json();
    await user.api.post('/api/files/folders', {
      project_id: projectId,
      name: 'Cards',
      parent_id: art.id,
    });
    await user.api.postBytes(
      `/api/files/upload?project_id=${projectId}&folder_id=${art.id}&filename=cover.png`,
      pngBytes(2) as unknown as BodyInit
    );
  });

  afterAll(async () => {
    await deleteUser(user);
  });

  it('completes project names', async () => {
    expect(await complete('threepeaks project show Comp')).toEqual(['Completed Game']);
  });

  it('completes decks within the project named on the line', async () => {
    expect(await complete('threepeaks deck show --project Completed H')).toEqual(['Heroes']);
  });

  it('completes the cards of the deck typed before them', async () => {
    expect(await complete('threepeaks deck copies --project Completed Heroes ')).toEqual([
      'knight.png',
    ]);
  });

  it('completes an Assets path one directory at a time', async () => {
    expect(await complete('threepeaks download --project Completed ')).toEqual(['Art/']);
    expect(await complete('threepeaks download --project Completed Art/')).toEqual([
      'Art/Cards/',
      'Art/cover.png',
    ]);
    expect(await complete('threepeaks upload --project Completed --to Art/')).toEqual([
      'Art/Cards/',
    ]);
  });

  it('prints nothing rather than an error when it cannot tell the project', async () => {
    const res = await h.runCli(['__complete', '--', 'threepeaks', 'deck', 'show', '']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toBe('');
  });

  it('prints each shell’s script', async () => {
    for (const shell of ['bash', 'zsh', 'fish']) {
      const res = await h.runCli(['completion', '-s', shell]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('threepeaks __complete');
    }
  });
});
