import { Option, type Command } from 'commander';
import type { components } from '@three-peaks/shared/api';
import { PROJECT_ROLES, formatBytes, type ProjectRole } from '@three-peaks/shared';
import { group, inProject, leaf, optString, withCtx, type Opts } from '../kit.ts';
import { CliError, EXIT, assertDone, assertOk } from '../errors.ts';
import { confirmOrAbort } from '../prompt.ts';
import { day, shortId } from '../output.ts';
import {
  fetchDirectory,
  listMembers,
  listProjects,
  matchMember,
  projectFromOpts,
  resolveProject,
  type Member,
  type Project,
} from '../resolve.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

type User = components['schemas']['User'];

async function me(ctx: RuntimeContext): Promise<User> {
  return assertOk(await ctx.api.GET('/api/auth/me'));
}

// The creator has no member row and is always an editor, so "owner" is the only
// word that tells them apart from an editor somebody added.
function roleLabel(member: Pick<Member, 'role' | 'is_creator'>): string {
  return member.is_creator ? 'owner' : member.role;
}

function withArticle(role: ProjectRole): string {
  return role === 'editor' ? 'an editor' : 'a viewer';
}

function roleOption(description: string): Option {
  return new Option('--role <role>', description).choices([...PROJECT_ROLES]);
}

function printProject(ctx: RuntimeContext, project: Project, verb: string): void {
  ctx.out.data(project, () =>
    ctx.out.line(`${verb} project ${project.name} (${shortId(project.id)})`)
  );
}

function descriptionFrom(opts: Opts): string | null | undefined {
  const description = optString(opts, 'description');
  if (opts.clearDescription === true) {
    if (description !== undefined) {
      throw new CliError('Pass --description or --clear-description, not both', EXIT.usage);
    }
    return null;
  }
  return description;
}

async function setRole(
  ctx: RuntimeContext,
  project: Project,
  email: string,
  role: ProjectRole
): Promise<Member> {
  assertDone(
    await ctx.api.PUT('/api/projects/{id}/members', {
      params: { path: { id: project.id } },
      body: { email, role },
    })
  );
  const members = await listMembers(ctx, project.id);
  const member = members.find((m) => m.email.toLowerCase() === email.toLowerCase());
  if (member === undefined) {
    throw new CliError(`${email} was not listed after the change`, EXIT.failure);
  }
  return member;
}

function registerMemberCommands(project: Command, deps: CliDeps): void {
  project.addCommand(
    leaf('members')
      .description('List the people on a project and their roles')
      .argument('[project]', 'project id or name (default: the configured project)')
      .action(
        withCtx(deps, async (ctx, _opts, ref) => {
          const target = await resolveProject(ctx, ref);
          const members = await listMembers(ctx, target.id);
          ctx.out.data(members, () =>
            ctx.out.table(
              ['ID', 'NAME', 'EMAIL', 'ROLE'],
              members.map((m) => [shortId(m.user_id), m.name, m.email, roleLabel(m)])
            )
          );
        })
      )
  );

  const member = group('member', 'Add, change and remove project members (owner only)');

  member.addCommand(
    inProject(leaf('add'))
      .description('Give an existing account access to a project')
      .argument('<email>', 'the account’s email address')
      .addOption(roleOption('what they may do').default('editor'))
      .action(
        withCtx(deps, async (ctx, opts, email) => {
          const target = await projectFromOpts(ctx, opts);
          const role = opts.role as ProjectRole;
          // The route adds and changes alike, so a second `add` would quietly
          // change somebody's role; that is `set-role`'s job, said out loud.
          const existing = (await listMembers(ctx, target.id)).find(
            (m) => m.email.toLowerCase() === email.toLowerCase()
          );
          if (existing !== undefined) {
            throw new CliError(
              existing.is_creator
                ? `${existing.name} owns ${target.name} and is always an editor`
                : `${existing.name} is already ${withArticle(existing.role)} of ${target.name}; change that with: threepeaks project member set-role`,
              EXIT.conflict
            );
          }
          const added = await setRole(ctx, target, email, role);
          ctx.out.data(added, () =>
            ctx.out.line(`Added ${added.name} <${added.email}> to ${target.name} as ${role}`)
          );
        })
      )
  );

  member.addCommand(
    inProject(leaf('set-role'))
      .description('Change what a member may do')
      .argument('<member>', 'email, user id, id prefix or name')
      .addOption(roleOption('the new role').makeOptionMandatory())
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const target = await projectFromOpts(ctx, opts);
          const current = matchMember(ref, await listMembers(ctx, target.id));
          if (current.is_creator) {
            throw new CliError(
              `${current.name} owns ${target.name} and is always an editor`,
              EXIT.conflict
            );
          }
          const role = opts.role as ProjectRole;
          const updated = await setRole(ctx, target, current.email, role);
          ctx.out.data(updated, () =>
            ctx.out.line(`${updated.name} is now ${withArticle(role)} of ${target.name}`)
          );
        })
      )
  );

  member.addCommand(
    inProject(leaf('remove'))
      .description('Take away a member’s access')
      .argument('<member>', 'email, user id, id prefix or name')
      .option('--force', 'skip the confirmation prompt')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const target = await projectFromOpts(ctx, opts);
          const removed = matchMember(ref, await listMembers(ctx, target.id));
          if (removed.is_creator) {
            throw new CliError(
              `${removed.name} owns ${target.name} and cannot be removed`,
              EXIT.conflict
            );
          }
          await confirmOrAbort(
            ctx,
            `Remove ${removed.name} <${removed.email}> from ${target.name}?`,
            opts.force === true
          );
          assertDone(
            await ctx.api.DELETE('/api/projects/{id}/members/{userId}', {
              params: { path: { id: target.id, userId: removed.user_id } },
            })
          );
          ctx.out.data({ removed: removed.user_id, project_id: target.id }, () =>
            ctx.out.line(`Removed ${removed.name} from ${target.name}`)
          );
        })
      )
  );

  project.addCommand(member);
}

export function registerProject(program: Command, deps: CliDeps): void {
  const project = group('project', 'List, create and manage projects and their members');

  project.addCommand(
    leaf('list')
      .description('List the projects you own or are a member of')
      .action(
        withCtx(deps, async (ctx) => {
          const projects = await listProjects(ctx);
          ctx.out.data(projects, () => {
            if (projects.length === 0) {
              ctx.out.line('No projects yet; create one with: threepeaks project create <name>');
              return;
            }
            ctx.out.table(
              ['ID', 'NAME', 'ROLE', 'UPDATED'],
              projects.map((p) => [shortId(p.id), p.name, p.role, day(p.updated_at)])
            );
          });
        })
      )
  );

  project.addCommand(
    leaf('show')
      .description('Show a project, its owner and how much of its storage is used')
      .argument('[project]', 'project id or name (default: the configured project)')
      .action(
        withCtx(deps, async (ctx, _opts, ref) => {
          const target = await resolveProject(ctx, ref);
          const [members, root] = await Promise.all([
            listMembers(ctx, target.id),
            fetchDirectory(ctx, target.id, null),
          ]);
          const owner = members.find((m) => m.is_creator) ?? null;
          const detail = {
            ...target,
            owner:
              owner === null
                ? null
                : { user_id: owner.user_id, name: owner.name, email: owner.email },
            member_count: members.length,
            storage_used_bytes: root.storage_used_bytes,
            storage_quota_bytes: root.storage_quota_bytes,
          };
          ctx.out.data(detail, () => {
            const rows: [string, string][] = [
              ['Name', target.name],
              ['ID', target.id],
              ['Your role', target.role],
              ['Owner', owner === null ? '' : `${owner.name} <${owner.email}>`],
              ['Members', String(members.length)],
              [
                'Storage',
                `${formatBytes(root.storage_used_bytes)} of ${formatBytes(root.storage_quota_bytes)}`,
              ],
              ['Created', day(target.created_at)],
              ['Updated', day(target.updated_at)],
            ];
            if (target.description !== null) rows.splice(2, 0, ['Description', target.description]);
            const width = Math.max(...rows.map(([label]) => label.length));
            for (const [label, value] of rows) {
              ctx.out.line(`${`${label}:`.padEnd(width + 2)}${value}`);
            }
          });
        })
      )
  );

  project.addCommand(
    leaf('create')
      .description('Create a project; you become its owner')
      .argument('<name>', 'project name')
      .option('--description <text>', 'what the project is')
      .action(
        withCtx(deps, async (ctx, opts, name) => {
          const description = optString(opts, 'description');
          const created = assertOk(
            await ctx.api.POST('/api/projects', {
              body: {
                id: crypto.randomUUID(),
                name,
                ...(description === undefined ? {} : { description }),
              },
            })
          );
          printProject(ctx, created, 'Created');
        })
      )
  );

  project.addCommand(
    leaf('update')
      .description('Rename a project or change its description (editors only)')
      .argument('[project]', 'project id or name (default: the configured project)')
      .option('--name <name>', 'new name')
      .option('--description <text>', 'new description')
      .option('--clear-description', 'remove the description')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const name = optString(opts, 'name');
          const description = descriptionFrom(opts);
          if (name === undefined && description === undefined) {
            throw new CliError('Pass --name, --description or --clear-description', EXIT.usage);
          }
          const target = await resolveProject(ctx, ref);
          const updated = assertOk(
            await ctx.api.PATCH('/api/projects/{id}', {
              params: { path: { id: target.id } },
              body: {
                ...(name === undefined ? {} : { name }),
                ...(description === undefined ? {} : { description }),
              },
            })
          );
          printProject(ctx, updated, 'Updated');
        })
      )
  );

  project.addCommand(
    leaf('delete')
      .description('Permanently delete a project and everything in it (owner only)')
      .argument('<project>', 'project id or name')
      .option('--force', 'skip the confirmation prompt')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const target = await resolveProject(ctx, ref);
          // Asked before the prompt rather than left to the server, so nobody
          // confirms an irreversible delete only to be told it was never theirs.
          if (target.created_by !== (await me(ctx)).id) {
            throw new CliError(`Only the owner of ${target.name} can delete it`, EXIT.forbidden);
          }
          await confirmOrAbort(
            ctx,
            `Permanently delete ${target.name}, every file in it and every version of them? This cannot be undone.`,
            opts.force === true
          );
          assertDone(
            await ctx.api.DELETE('/api/projects/{id}', { params: { path: { id: target.id } } })
          );
          ctx.out.data({ deleted: target.id }, () =>
            ctx.out.line(`Deleted project ${target.name}`)
          );
        })
      )
  );

  project.addCommand(
    leaf('leave')
      .description('Remove yourself from a project you do not own')
      .argument('[project]', 'project id or name (default: the configured project)')
      .option('--force', 'skip the confirmation prompt')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const target = await resolveProject(ctx, ref);
          const self = await me(ctx);
          // The owner has no member row, so the route would answer 204 and
          // change nothing.
          if (target.created_by === self.id) {
            throw new CliError(
              `You own ${target.name}, and an owner cannot leave; delete it instead with: threepeaks project delete`,
              EXIT.conflict
            );
          }
          await confirmOrAbort(
            ctx,
            `Leave ${target.name}? You lose access until its owner adds you back.`,
            opts.force === true
          );
          assertDone(
            await ctx.api.DELETE('/api/projects/{id}/members/{userId}', {
              params: { path: { id: target.id, userId: self.id } },
            })
          );
          ctx.out.data({ left: target.id }, () => ctx.out.line(`Left ${target.name}`));
        })
      )
  );

  registerMemberCommands(project, deps);
  program.addCommand(project);
}
