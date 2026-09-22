import { Option, type Command } from 'commander';
import { basename } from 'node:path';
import {
  COMPONENT_FILE_ROLES,
  COMPONENT_KINDS,
  COMPONENT_KIND_INFO,
  defaultSettingsFor,
  formatBytes,
  type ComponentFileRole,
  type ComponentKind,
} from '@three-peaks/shared';
import { collect, group, inProject, leaf, optList, optString, withCtx, type Opts } from '../kit.ts';
import { ApiError, CliError, EXIT, assertDone, assertOk } from '../errors.ts';
import {
  UUID_RE,
  assertEditor,
  listComponents,
  listDeleted,
  matchRefOrNull,
  projectFromOpts,
  type Component,
  type FileRow,
} from '../resolve.ts';
import { applyAssignments, formatSettings, mergeSettings, readSettingsFile } from '../settings.ts';
import { appendVersion, downloadTarget, fetchFileBytes, sendFile } from '../transfer.ts';
import { localName } from '../assets.ts';
import { confirmOrAbort } from '../prompt.ts';
import { day, shortId } from '../output.ts';
import { placementFromOpts, reorder, sameOrder } from '../placement.ts';
import { restoreDeleted } from '../tombstones.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

type ComponentSettings = Component['settings'];

function kindOf(component: Component): ComponentKind {
  return component.kind as ComponentKind;
}

function singular(component: Component): string {
  return COMPONENT_KIND_INFO[kindOf(component)].singular;
}

function label(component: Component): string {
  return `${singular(component)} "${component.name}"`;
}

async function fetchComponent(ctx: RuntimeContext, componentId: string): Promise<Component> {
  return assertOk(
    await ctx.api.GET('/api/components/{componentId}', { params: { path: { componentId } } })
  );
}

function restoreHint(component: Component): string {
  return `threepeaks component restore ${component.id}`;
}

// The live listing is where a name is looked up, because two components can
// share a name when one of them is deleted. `deleted` says whether a tombstone
// may answer instead: reading one, saving its settings and purging it are all
// allowed, and anything that changes its contents is not.
async function locate(
  ctx: RuntimeContext,
  opts: Opts,
  ref: string,
  deleted: 'allow' | 'refuse'
): Promise<Component> {
  let found: Component | null;
  if (UUID_RE.test(ref)) {
    found = await fetchComponent(ctx, ref);
  } else {
    const project = await projectFromOpts(ctx, opts);
    found = matchRefOrNull(
      ref,
      await listComponents(ctx, project.id),
      'component',
      (c) => c.id,
      (c) => c.name
    );
    if (found === null) {
      const tombstone = matchRefOrNull(
        ref,
        (await listDeleted(ctx, project.id)).filter((entry) => entry.kind === 'component'),
        'deleted component',
        (e) => e.id,
        (e) => e.name
      );
      if (tombstone === null) {
        throw new CliError(`No component matching "${ref}" in "${project.name}"`, EXIT.notFound);
      }
      found = await fetchComponent(ctx, tombstone.id);
    }
  }
  if (deleted === 'refuse' && found.deleted_at !== null) {
    throw new CliError(
      `${label(found)} is deleted; restore it first with: ${restoreHint(found)}`,
      EXIT.conflict
    );
  }
  return found;
}

function roleArgument(component: Component, requested: string | undefined): ComponentFileRole {
  const roles = COMPONENT_KIND_INFO[kindOf(component)].roles;
  const role = (requested ?? component.missing_roles[0] ?? 'artwork') as ComponentFileRole;
  if (!roles.includes(role)) {
    throw new CliError(
      `A ${singular(component)} has no ${role} file; it takes: ${roles.join(', ')}`,
      EXIT.usage
    );
  }
  return role;
}

function fileFor(component: Component, role: ComponentFileRole): FileRow | null {
  return component.files.find((entry) => entry.role === role)?.file ?? null;
}

// One cell per role the kind takes, so a component still waiting for its
// artwork reads as waiting rather than as a blank.
function filesSummary(component: Component): string {
  return COMPONENT_KIND_INFO[kindOf(component)].roles
    .map((role) => {
      const file = fileFor(component, role);
      if (file === null) return `${role}: missing`;
      return `${role}: ${file.filename}${file.deleted_at === null ? '' : ' (deleted)'}`;
    })
    .join(', ');
}

function printSection(ctx: RuntimeContext, kind: ComponentKind, rows: readonly Component[]): void {
  ctx.out.line(COMPONENT_KIND_INFO[kind].section);
  ctx.out.table(
    ['#', 'ID', 'NAME', 'FILES'],
    rows.map((component, index) => [
      String(index + 1),
      shortId(component.id),
      component.name,
      filesSummary(component),
    ])
  );
}

function printComponent(ctx: RuntimeContext, component: Component): void {
  const kind = kindOf(component);
  ctx.out.line(`${component.name}  (${kind})`);
  ctx.out.line(`id       ${component.id}`);
  ctx.out.line(`section  ${COMPONENT_KIND_INFO[kind].section}`);
  if (component.deleted_at !== null) {
    ctx.out.line(`deleted  ${day(component.deleted_at)} — restore with: ${restoreHint(component)}`);
  }
  for (const role of COMPONENT_KIND_INFO[kind].roles) {
    const file = fileFor(component, role);
    ctx.out.line(
      file === null
        ? `${role.padEnd(8)} missing`
        : `${role.padEnd(8)} ${file.filename}  ${formatBytes(file.byte_size)}  ${shortId(file.id)}` +
            (file.deleted_at === null ? '' : '  (deleted)')
    );
  }
  ctx.out.line('settings');
  for (const line of formatSettings(component.settings)) {
    ctx.out.line(`  ${line}`);
  }
}

function sameSettings(a: object, b: object): boolean {
  const canonical = (value: object) =>
    JSON.stringify(
      Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)))
    );
  return canonical(a) === canonical(b);
}

async function settingsFromFlags(
  ctx: RuntimeContext,
  opts: Opts,
  start: ComponentSettings
): Promise<ComponentSettings> {
  let next = start;
  const file = optString(opts, 'file');
  if (file !== undefined) {
    next = mergeSettings(next, await readSettingsFile(ctx, file));
  }
  return applyAssignments(next, optList(opts, 'set'));
}

function settingsOptions(cmd: Command): Command {
  return cmd
    .option('--set <key=value>', 'change one setting; repeatable', collect, [])
    .option('--file <path>', 'lay a JSON object of settings over them ("-" reads stdin)');
}

export function registerComponent(program: Command, deps: CliDeps): void {
  const component = group(
    'component',
    'Manage components: wooden pieces, boxes, boards and punchboards'
  );

  component.addCommand(
    leaf('kinds')
      .description('List the kinds of component and the files each one takes')
      .action(
        withCtx(deps, async (ctx) => {
          const kinds = COMPONENT_KINDS.map((kind) => ({ kind, ...COMPONENT_KIND_INFO[kind] }));
          ctx.out.data(kinds, () =>
            ctx.out.table(
              ['KIND', 'SECTION', 'FILES'],
              kinds.map((row) => [row.kind, row.section, row.roles.join(', ')])
            )
          );
        })
      )
  );

  component.addCommand(
    inProject(
      leaf('list')
        .description('List components by section, in their section order')
        .addOption(new Option('--kind <kind>', 'only one section').choices([...COMPONENT_KINDS]))
    ).action(
      withCtx(deps, async (ctx, opts) => {
        const project = await projectFromOpts(ctx, opts);
        const only = optString(opts, 'kind') as ComponentKind | undefined;
        const rows = await listComponents(ctx, project.id, only);
        ctx.out.data(rows, () => {
          if (rows.length === 0) {
            const what =
              only === undefined ? 'components' : COMPONENT_KIND_INFO[only].section.toLowerCase();
            ctx.out.line(`No ${what} in "${project.name}"`);
            return;
          }
          const sections = COMPONENT_KINDS.filter((kind) => rows.some((r) => r.kind === kind));
          sections.forEach((kind, index) => {
            if (index > 0) ctx.out.line();
            printSection(
              ctx,
              kind,
              rows.filter((row) => row.kind === kind)
            );
          });
        });
      })
    )
  );

  component.addCommand(
    inProject(
      leaf('show')
        .description('Show a component: its files, what it is missing, and its settings')
        .argument('<component>', 'component id or name; a deleted one is found too')
    ).action(
      withCtx(deps, async (ctx, opts, ref) => {
        const found = await locate(ctx, opts, ref, 'allow');
        ctx.out.data(found, () => printComponent(ctx, found));
      })
    )
  );

  component.addCommand(
    settingsOptions(
      inProject(
        leaf('create')
          .description('Create a component; its artwork is uploaded into it afterwards')
          .argument('<name>', 'what the component is called')
          .addOption(
            new Option('--kind <kind>', 'what it is')
              .choices([...COMPONENT_KINDS])
              .makeOptionMandatory()
          )
      )
    ).action(
      withCtx(deps, async (ctx, opts, name) => {
        const project = await projectFromOpts(ctx, opts);
        assertEditor(project);
        const kind = opts.kind as ComponentKind;
        const customised = optString(opts, 'file') !== undefined || optList(opts, 'set').length > 0;
        const settings = customised
          ? await settingsFromFlags(ctx, opts, defaultSettingsFor(kind) as ComponentSettings)
          : undefined;
        const created = assertOk(
          await ctx.api.POST('/api/components', {
            body: {
              id: crypto.randomUUID(),
              project_id: project.id,
              kind,
              name,
              ...(settings === undefined ? {} : { settings }),
            },
          })
        );
        ctx.out.data(created, () => {
          ctx.out.line(`Created ${label(created)} (${shortId(created.id)})`);
          if (created.missing_roles.length > 0) {
            ctx.out.line(
              `Upload its ${created.missing_roles.join(' and ')} with: threepeaks component upload ${shortId(created.id)} <path>`
            );
          }
        });
      })
    )
  );

  component.addCommand(
    inProject(
      leaf('rename')
        .description('Rename a component')
        .argument('<component>', 'component id or name')
        .argument('<name>', 'the new name')
    ).action(
      withCtx(deps, async (ctx, opts, ref, name) => {
        const found = await locate(ctx, opts, ref, 'refuse');
        const updated = assertOk(
          await ctx.api.PATCH('/api/components/{componentId}', {
            params: { path: { componentId: found.id } },
            body: { name },
          })
        );
        ctx.out.data(updated, () => ctx.out.line(`Renamed ${label(found)} to "${updated.name}"`));
      })
    )
  );

  component.addCommand(
    settingsOptions(
      inProject(
        leaf('settings')
          .description('Show a component’s settings, or change them')
          .argument('<component>', 'component id or name; a deleted one is found too')
          .option('--reset', 'start from the defaults for its kind')
      )
    ).action(
      withCtx(deps, async (ctx, opts, ref) => {
        const found = await locate(ctx, opts, ref, 'allow');
        const editing =
          opts.reset === true ||
          optString(opts, 'file') !== undefined ||
          optList(opts, 'set').length > 0;
        if (!editing) {
          ctx.out.data(found.settings, () => {
            for (const line of formatSettings(found.settings)) ctx.out.line(line);
          });
          return;
        }
        const start =
          opts.reset === true
            ? (defaultSettingsFor(kindOf(found)) as ComponentSettings)
            : found.settings;
        const settings = await settingsFromFlags(ctx, opts, start);
        // The whole blob is written and announced on every save, so one that
        // changes nothing is not sent at all.
        if (sameSettings(settings, found.settings)) {
          ctx.out.data(found, () => ctx.out.line(`No change to the settings of ${label(found)}`));
          return;
        }
        const updated = assertOk(
          await ctx.api.PATCH('/api/components/{componentId}', {
            params: { path: { componentId: found.id } },
            body: { settings },
          })
        );
        ctx.out.data(updated, () => {
          ctx.out.line(`Saved the settings of ${label(updated)}`);
          for (const line of formatSettings(updated.settings)) ctx.out.line(`  ${line}`);
        });
      })
    )
  );

  component.addCommand(
    inProject(
      leaf('upload')
        .description('Upload a component’s artwork or cut sheet; a filled slot gains a new version')
        .argument('<component>', 'component id or name')
        .argument('<path>', 'the local file')
        .addOption(
          new Option(
            '--role <role>',
            'which file this is (default: the first one it is missing, else artwork)'
          ).choices([...COMPONENT_FILE_ROLES])
        )
    ).action(
      withCtx(deps, async (ctx, opts, ref, path) => {
        const found = await locate(ctx, opts, ref, 'refuse');
        const role = roleArgument(found, optString(opts, 'role'));
        const slot = fileFor(found, role);

        if (slot === null) {
          const { body: file } = await sendFile<FileRow>(
            ctx,
            '/api/files/upload',
            {
              project_id: found.project_id,
              filename: basename(path),
              component_id: found.id,
              role,
            },
            path
          );
          const after = await fetchComponent(ctx, found.id);
          ctx.out.data(
            {
              path,
              outcome: 'uploaded',
              file,
              file_id: file.id,
              filename: file.filename,
              role,
              missing_roles: after.missing_roles,
            },
            () => {
              ctx.out.line(`Uploaded ${file.filename} as the ${role} of ${label(found)}`);
              if (after.missing_roles.length > 0) {
                ctx.out.line(`Still missing: ${after.missing_roles.join(', ')}`);
              }
            }
          );
          return;
        }

        // The slot's file holds its role even while it is deleted, so a new
        // upload would collide with it; the tombstone has to go one way or the
        // other before anything can take its place.
        if (slot.deleted_at !== null) {
          throw new CliError(
            `The ${role} of ${label(found)} is a deleted file, ${slot.filename} (${slot.id}). ` +
              `Restore it to add a version to it, or purge it to upload a new one: ` +
              `threepeaks trash restore ${slot.id} | threepeaks trash purge ${slot.id}`,
            EXIT.conflict
          );
        }

        // A new version rather than a replacement file: history only grows, so
        // the artwork it had stays one restore away.
        const result = await appendVersion(ctx, slot, path);
        ctx.out.data({ ...result, role }, () =>
          ctx.out.line(
            result.outcome === 'versioned'
              ? `Replaced the ${role} of ${label(found)} with ${basename(path)} (version ${String(result.version?.version_number)})`
              : `${basename(path)} is identical to the current ${role} of ${label(found)}; nothing changed`
          )
        );
      })
    )
  );

  component.addCommand(
    inProject(
      leaf('download')
        .description('Download a component’s artwork or cut sheet')
        .argument('<component>', 'component id or name; a deleted one is found too')
        .addOption(
          new Option('--role <role>', 'which file (default: artwork)').choices([
            ...COMPONENT_FILE_ROLES,
          ])
        )
        .option('-o, --output <path>', 'where to write it: a file, a directory, or "-" for stdout')
        .option('--force', 'overwrite a file that already exists')
    ).action(
      withCtx(deps, async (ctx, opts, ref) => {
        const found = await locate(ctx, opts, ref, 'allow');
        const role = roleArgument(found, optString(opts, 'role') ?? 'artwork');
        const file = fileFor(found, role);
        if (file === null) {
          throw new CliError(`${label(found)} has no ${role} yet`, EXIT.notFound);
        }
        const target = await downloadTarget(
          optString(opts, 'output'),
          localName(file.filename, file.id),
          opts.force === true
        );
        const size = await fetchFileBytes(ctx, file.id, undefined, target);
        if (target === '-') return;
        ctx.out.data({ path: target, size_bytes: size, file_id: file.id, role }, () =>
          ctx.out.line(`Wrote ${target} (${formatBytes(size)})`)
        );
      })
    )
  );

  component.addCommand(
    inProject(
      leaf('move')
        .description('Move a component within its section')
        .argument('<component>', 'component id or name')
        .option('--top', 'first in its section')
        .option('--bottom', 'last in its section')
        .option('--before <component>', 'just before another of the same kind')
        .option('--after <component>', 'just after another of the same kind')
        .option('--position <n>', 'to this place in the section, counting from 1')
    ).action(
      withCtx(deps, async (ctx, opts, ref) => {
        const placement = placementFromOpts(opts);
        const found = await locate(ctx, opts, ref, 'refuse');
        const kind = kindOf(found);
        const info = COMPONENT_KIND_INFO[kind];
        const section = await listComponents(ctx, found.project_id, kind);

        let anchorId: string | undefined;
        if (placement.kind === 'before' || placement.kind === 'after') {
          const anchor = matchRefOrNull(
            placement.ref,
            section,
            info.singular,
            (c) => c.id,
            (c) => c.name
          );
          if (anchor === null) {
            throw new CliError(
              `No ${info.singular} matching "${placement.ref}" in ${info.section}; ` +
                `--${placement.kind} names another ${info.singular}`,
              EXIT.notFound
            );
          }
          anchorId = anchor.id;
        }

        const current = section.map((c) => c.id);
        const wanted = reorder(current, found.id, placement, anchorId);
        const place = wanted.indexOf(found.id) + 1;
        if (sameOrder(current, wanted)) {
          ctx.out.data({ moved: false, components: section }, () =>
            ctx.out.line(`${label(found)} is already #${String(place)} in ${info.section}`)
          );
          return;
        }
        const { components: reordered } = assertOk(
          await ctx.api.PUT('/api/components/order', {
            body: { project_id: found.project_id, kind, component_ids: wanted },
          })
        );
        ctx.out.data({ moved: true, components: reordered }, () => {
          ctx.out.line(`Moved ${label(found)} to #${String(place)} in ${info.section}`);
          ctx.out.line();
          printSection(ctx, kind, reordered);
        });
      })
    )
  );

  component.addCommand(
    inProject(
      leaf('delete')
        .description('Delete a component; --purge also destroys its artwork for good')
        .argument('<component>', 'component id or name; with --purge a deleted one is found too')
        .option('--purge', 'delete permanently, reclaiming its storage; cannot be undone')
        .option('--force', 'skip the confirmation --purge asks for')
    ).action(
      withCtx(deps, async (ctx, opts, ref) => {
        const purge = opts.purge === true;
        const found = await locate(ctx, opts, ref, 'allow');
        if (!purge && found.deleted_at !== null) {
          ctx.out.data({ deleted: found.id, purged: false }, () =>
            ctx.out.line(`${label(found)} is already deleted`)
          );
          return;
        }
        if (purge) {
          await confirmOrAbort(
            ctx,
            `Permanently delete ${label(found)} and every version of its files? This cannot be undone.`,
            opts.force === true
          );
        }
        assertDone(
          await ctx.api.DELETE('/api/components/{componentId}', {
            params: {
              path: { componentId: found.id },
              ...(purge ? { query: { purge: 'true' as const } } : {}),
            },
          })
        );
        ctx.out.data({ deleted: found.id, purged: purge }, () =>
          ctx.out.line(
            purge
              ? `Permanently deleted ${label(found)}`
              : `Deleted ${label(found)}; restore it with: ${restoreHint(found)}`
          )
        );
      })
    )
  );

  component.addCommand(
    inProject(
      leaf('restore')
        .description('Restore a deleted component, with whatever artwork it still has')
        .argument('<component>', 'deleted component id or name')
        .option('--name <name>', 'restore it under a new name, when its own has been taken')
    ).action(
      withCtx(deps, async (ctx, opts, ref) => {
        // Tombstones first: a name can belong to a live component and to a
        // deleted one at once, and here it is the deleted one being asked for.
        let target: Component;
        if (UUID_RE.test(ref)) {
          target = await fetchComponent(ctx, ref);
        } else {
          const project = await projectFromOpts(ctx, opts);
          const tombstone = matchRefOrNull(
            ref,
            (await listDeleted(ctx, project.id)).filter((entry) => entry.kind === 'component'),
            'deleted component',
            (e) => e.id,
            (e) => e.name
          );
          target =
            tombstone === null
              ? await locate(ctx, opts, ref, 'allow')
              : await fetchComponent(ctx, tombstone.id);
        }
        if (target.deleted_at === null) {
          ctx.out.data(target, () => ctx.out.line(`${label(target)} is not deleted`));
          return;
        }
        const name = optString(opts, 'name');
        let restored: Component;
        try {
          restored = (await restoreDeleted(
            ctx,
            { kind: 'component', id: target.id },
            name
          )) as Component;
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && name === undefined) {
            throw new CliError(
              `${err.message}; pass --name to restore it as something else`,
              EXIT.conflict
            );
          }
          throw err;
        }
        ctx.out.data(restored, () => ctx.out.line(`Restored ${label(restored)}`));
      })
    )
  );

  program.addCommand(component);
}
