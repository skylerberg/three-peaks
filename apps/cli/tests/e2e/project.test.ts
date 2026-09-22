import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECT_STORAGE_QUOTA_BYTES } from '@three-peaks/shared';
import {
  createUser,
  deleteUser,
  uniqueEmail,
  type TestUser,
} from '../../../api/tests/setup/testContext.ts';
import { API_URL, createCliHarness, signedInHarness, type CliHarness } from './helpers.ts';
import type { Member, Project } from '../../src/resolve.ts';

describe('project commands', () => {
  let h: CliHarness;
  let owner: TestUser;
  let other: TestUser;
  let otherH: CliHarness;

  beforeAll(async () => {
    ({ h, user: owner } = await signedInHarness('cli-project'));
    other = await createUser('cli-project-other');
    otherH = await createCliHarness();
    await otherH.credentials.set(API_URL, other.token);
  });

  afterAll(async () => {
    await deleteUser(owner);
    await deleteUser(other);
  });

  async function create(name: string, harness = h): Promise<Project> {
    const res = await harness.runCli(['project', 'create', name, '--json']);
    expect(res.exitCode).toBe(0);
    return res.json<Project>();
  }

  describe('create, list and show', () => {
    it('creates a project and lists it with the caller’s role', async () => {
      const res = await h.runCli([
        'project',
        'create',
        'Summit',
        '--description',
        'A climbing game',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toMatch(/^Created project Summit \([0-9a-f]{8}\)\n$/);

      const list = await h.runCli(['project', 'list']);
      expect(list.stdout).toMatch(/Summit\s+editor/);
    });

    it('says so when there are no projects', async () => {
      const lonely = await signedInHarness('cli-project-empty');
      try {
        const res = await lonely.h.runCli(['project', 'list']);
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain('No projects yet');
      } finally {
        await deleteUser(lonely.user);
      }
    });

    it('show names the owner, the member count and the storage used', async () => {
      const project = await create('Shown');
      const res = await h.runCli(['project', 'show', project.id.slice(0, 8)]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain(`Owner:`);
      expect(res.stdout).toContain(owner.email);
      expect(res.stdout).toMatch(/Members:\s+1/);
      expect(res.stdout).toMatch(/Storage:\s+0 B of 10 GB/);

      const json = (await h.runCli(['project', 'show', 'Shown', '--json'])).json<
        Project & { storage_quota_bytes: number; owner: { email: string } }
      >();
      expect(json.storage_quota_bytes).toBe(PROJECT_STORAGE_QUOTA_BYTES);
      expect(json.owner.email).toBe(owner.email);
      expect(json.role).toBe('editor');
    });

    it('show falls back to THREEPEAKS_PROJECT, and needs a project from somewhere', async () => {
      const project = await create('From env');
      const res = await h.runCli(['project', 'show', '--json'], {
        env: { THREEPEAKS_PROJECT: 'From env' },
      });
      expect(res.json<Project>().id).toBe(project.id);

      const none = await h.runCli(['project', 'show']);
      expect(none.exitCode).toBe(2);
      expect(none.stderr).toContain('No project specified');
    });

    it('an ambiguous name is exit 2 and lists the candidates', async () => {
      await create('Twin Peaks A');
      await create('Twin Peaks B');
      const res = await h.runCli(['project', 'show', 'Twin Peaks']);
      expect(res.exitCode).toBe(2);
      expect(res.stderr).toContain('Ambiguous project');
      expect(res.stderr).toContain('Twin Peaks A');
    });
  });

  describe('update', () => {
    it('renames, sets and clears the description', async () => {
      const project = await create('Before');
      const renamed = await h.runCli([
        'project',
        'update',
        project.id,
        '--name',
        'After',
        '--description',
        'Now described',
        '--json',
      ]);
      expect(renamed.exitCode).toBe(0);
      expect(renamed.json<Project>()).toMatchObject({
        name: 'After',
        description: 'Now described',
      });

      const cleared = await h.runCli([
        'project',
        'update',
        project.id,
        '--clear-description',
        '--json',
      ]);
      expect(cleared.json<Project>().description).toBeNull();
    });

    it('refuses nothing to change, and a description both set and cleared', async () => {
      const project = await create('Unchanged');
      expect((await h.runCli(['project', 'update', project.id])).exitCode).toBe(2);
      const both = await h.runCli([
        'project',
        'update',
        project.id,
        '--description',
        'x',
        '--clear-description',
      ]);
      expect(both.exitCode).toBe(2);
    });

    it('a viewer is refused with exit 7', async () => {
      const project = await create('Viewed');
      await h.runCli([
        'project',
        'member',
        'add',
        other.email,
        '--role',
        'viewer',
        '--project',
        project.id,
      ]);
      const res = await otherH.runCli(['project', 'update', project.id, '--name', 'Mine now']);
      expect(res.exitCode).toBe(7);
    });
  });

  describe('members', () => {
    it('adds a member as an editor by default and lists them under the owner', async () => {
      const project = await create('Team');
      const added = await h.runCli(['project', 'member', 'add', other.email, '--project', 'Team']);
      expect(added.exitCode).toBe(0);
      expect(added.stdout).toContain(`as editor`);

      const members = await h.runCli(['project', 'members', project.id]);
      const lines = members.stdout.trim().split('\n');
      expect(lines[1]).toMatch(/owner$/);
      expect(members.stdout).toMatch(new RegExp(`${other.email}\\s+editor`));

      // The member now sees it too.
      const theirs = await otherH.runCli(['project', 'list']);
      expect(theirs.stdout).toContain('Team');
    });

    it('refuses to add somebody twice rather than changing their role', async () => {
      const project = await create('Twice');
      await h.runCli(['project', 'member', 'add', other.email, '--project', project.id]);
      const again = await h.runCli([
        'project',
        'member',
        'add',
        other.email,
        '--role',
        'viewer',
        '--project',
        project.id,
      ]);
      expect(again.exitCode).toBe(5);
      expect(again.stderr).toContain('set-role');

      const self = await h.runCli([
        'project',
        'member',
        'add',
        owner.email,
        '--project',
        project.id,
      ]);
      expect(self.exitCode).toBe(5);
    });

    it('an address with no account is exit 4', async () => {
      const project = await create('Nobody');
      const res = await h.runCli([
        'project',
        'member',
        'add',
        uniqueEmail('ghost'),
        '--project',
        project.id,
      ]);
      expect(res.exitCode).toBe(4);
    });

    it('rejects a role that is not one', async () => {
      const project = await create('Roles');
      const res = await h.runCli([
        'project',
        'member',
        'add',
        other.email,
        '--role',
        'admin',
        '--project',
        project.id,
      ]);
      expect(res.exitCode).toBe(2);
    });

    it('changes a role, by name, and not the owner’s', async () => {
      const project = await create('Promotions');
      await h.runCli(['project', 'member', 'add', other.email, '--project', project.id]);
      const res = await h.runCli([
        'project',
        'member',
        'set-role',
        other.name,
        '--role',
        'viewer',
        '--project',
        project.id,
        '--json',
      ]);
      expect(res.exitCode).toBe(0);
      expect(res.json<Member>().role).toBe('viewer');

      const ownerRole = await h.runCli([
        'project',
        'member',
        'set-role',
        owner.email,
        '--role',
        'viewer',
        '--project',
        project.id,
      ]);
      expect(ownerRole.exitCode).toBe(5);
    });

    it('only the owner manages members', async () => {
      const project = await create('Owned');
      await h.runCli(['project', 'member', 'add', other.email, '--project', project.id]);
      const outsider = await createUser('cli-project-outsider');
      try {
        const res = await otherH.runCli([
          'project',
          'member',
          'add',
          outsider.email,
          '--project',
          project.id,
        ]);
        expect(res.exitCode).toBe(7);
      } finally {
        await deleteUser(outsider);
      }
    });

    it('removes a member after confirming, and never the owner', async () => {
      const project = await create('Shrinking');
      await h.runCli(['project', 'member', 'add', other.email, '--project', project.id]);

      const refused = await h.runCli([
        'project',
        'member',
        'remove',
        other.email,
        '--project',
        project.id,
        '--no-input',
      ]);
      expect(refused.exitCode).toBe(2);

      const removed = await h.runCli(
        ['project', 'member', 'remove', other.email, '--project', project.id],
        { stdin: 'y\n' }
      );
      expect(removed.exitCode).toBe(0);
      const list = await h.runCli(['project', 'members', project.id, '--json']);
      expect(list.json<Member[]>().map((m) => m.email)).not.toContain(other.email);

      const ownerGone = await h.runCli([
        'project',
        'member',
        'remove',
        owner.email,
        '--project',
        project.id,
        '--force',
      ]);
      expect(ownerGone.exitCode).toBe(5);
    });
  });

  describe('leave and delete', () => {
    it('a member leaves and loses access', async () => {
      const project = await create('Leaving');
      await h.runCli(['project', 'member', 'add', other.email, '--project', project.id]);
      const res = await otherH.runCli(['project', 'leave', project.id, '--force']);
      expect(res.exitCode).toBe(0);
      expect((await otherH.runCli(['project', 'show', project.id])).exitCode).toBe(4);
    });

    it('the owner cannot leave', async () => {
      const project = await create('Anchored');
      const res = await h.runCli(['project', 'leave', project.id, '--force']);
      expect(res.exitCode).toBe(5);
      expect(res.stderr).toContain('project delete');
    });

    it('only the owner deletes, and is refused before being asked', async () => {
      const project = await create('Guarded');
      await h.runCli(['project', 'member', 'add', other.email, '--project', project.id]);
      const res = await otherH.runCli(['project', 'delete', project.id], { stdin: 'y\n' });
      expect(res.exitCode).toBe(7);
      expect(res.stderr).not.toContain('[y/N]');
    });

    it('delete confirms, and is gone afterwards', async () => {
      const project = await create('Doomed');
      const refused = await h.runCli(['project', 'delete', project.id, '--no-input']);
      expect(refused.exitCode).toBe(2);

      const res = await h.runCli(['project', 'delete', project.id, '--force']);
      expect(res.exitCode).toBe(0);
      expect((await h.runCli(['project', 'show', project.id])).exitCode).toBe(4);
    });
  });
});
