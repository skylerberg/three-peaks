import type { Command } from 'commander';
import { basename } from 'node:path';
import { formatBytes } from '@three-peaks/shared';
import type { components } from '@three-peaks/shared/api';
import { group, inProject, leaf, optString, withCtx, type Opts } from '../kit.ts';
import { CliError, EXIT, assertDone, assertOk } from '../errors.ts';
import { confirmOrAbort } from '../prompt.ts';
import { day, minute, shortId } from '../output.ts';
import {
  UUID_RE,
  fileScopeFromOpts,
  folderPathOf,
  listDeleted,
  matchDeleted,
  projectFromOpts,
  resolveComponent,
  resolveDeck,
  resolveFileRef,
  resolveFolderPath,
  type DeletedEntry,
  type FileRow,
  type Folder,
} from '../resolve.ts';
import {
  appendVersion,
  downloadTarget,
  fetchFileBytes,
  sendFile,
  uploadEach,
} from '../transfer.ts';
import {
  assetsPath,
  describeHome,
  ensureFolderPath,
  localName,
  parsePositiveInt,
  versionedName,
} from '../assets.ts';
import { restoreDeleted } from '../tombstones.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

type FileVersionResult = components['schemas']['FileVersionResult'];

const DECK_SCOPE = ['--deck <deck>', 'look the file up among this deck’s cards'] as const;
const COMPONENT_SCOPE = [
  '--component <component>',
  'look the file up among this component’s files (by role or name)',
] as const;
const FILE_ARG = [
  '<file>',
  'file id, or an Assets path such as Art/cover.png (or a card or role with --deck / --component)',
] as const;

async function resolveFile(ctx: RuntimeContext, opts: Opts, ref: string): Promise<FileRow> {
  return resolveFileRef(ctx, ref, fileScopeFromOpts(opts), optString(opts, 'project'));
}

function isRoot(path: string): boolean {
  return path.split('/').every((segment) => segment === '' || segment === '.');
}

// A tombstone is found through the deleted listing, which never lists what sits
// inside a deleted folder; a whole id still reaches one of those directly.
async function resolveTombstone(
  ctx: RuntimeContext,
  opts: Opts,
  ref: string,
  kind: 'file' | 'folder'
): Promise<{ kind: 'file' | 'folder'; id: string; label: string }> {
  const project = await projectFromOpts(ctx, opts);
  const entries = (await listDeleted(ctx, project.id)).filter((e) => e.kind === kind);
  if (UUID_RE.test(ref) && !entries.some((e) => e.id.toLowerCase() === ref.toLowerCase())) {
    return { kind, id: ref, label: ref };
  }
  const entry: DeletedEntry = matchDeleted(ref, entries);
  return { kind, id: entry.id, label: entry.name };
}

function typeLabel(file: {
  content_type: string;
  image_width: number | null;
  image_height: number | null;
}): string {
  return file.image_width !== null && file.image_height !== null
    ? `${file.content_type} (${String(file.image_width)} × ${String(file.image_height)})`
    : file.content_type;
}

function describeVersionResult(filename: string, result: FileVersionResult): string {
  return result.created
    ? `${filename} is now version ${String(result.version.version_number)}`
    : `Unchanged: ${filename} is already those bytes (version ${String(result.version.version_number)})`;
}

export function registerFiles(program: Command, deps: CliDeps): void {
  program.addCommand(
    inProject(leaf('ls'))
      .description('List one Assets folder: its folders, then its files')
      .argument('[folder]', 'folder path such as Art/Cards, or a folder id (default: the root)')
      .action(
        withCtx(deps, async (ctx, opts, folderRef) => {
          const project = await projectFromOpts(ctx, opts);
          const { listing } = await resolveFolderPath(ctx, project.id, folderRef ?? '');
          ctx.out.data(listing, () => {
            const where = assetsPath(folderPathOf(listing));
            ctx.out.line(ctx.out.style('bold', where));
            const folders = [...listing.folders].sort((a, b) => a.name.localeCompare(b.name));
            const files = [...listing.files].sort((a, b) => a.filename.localeCompare(b.filename));
            if (folders.length === 0 && files.length === 0) {
              ctx.out.line('Empty');
            } else {
              ctx.out.table(
                ['ID', 'NAME', 'SIZE', 'TYPE', 'UPDATED'],
                [
                  ...folders.map((f) => [
                    shortId(f.id),
                    `${f.name}/`,
                    '',
                    'folder',
                    day(f.updated_at),
                  ]),
                  ...files.map((f) => [
                    shortId(f.id),
                    f.filename,
                    formatBytes(f.byte_size),
                    f.content_type,
                    day(f.updated_at),
                  ]),
                ]
              );
            }
            ctx.out.line(
              ctx.out.style(
                'dim',
                `${formatBytes(listing.storage_used_bytes)} of ${formatBytes(listing.storage_quota_bytes)} used by ${project.name}`
              )
            );
          });
        })
      )
  );

  program.addCommand(
    inProject(leaf('mkdir'))
      .description('Create an Assets folder')
      .argument('<folder>', 'folder path such as Art/Cards')
      .option('-p, --parents', 'create missing parent folders, and accept one that already exists')
      .action(
        withCtx(deps, async (ctx, opts, path) => {
          const project = await projectFromOpts(ctx, opts);
          const ensured = await ensureFolderPath(ctx, project.id, path, opts.parents === true);
          ctx.out.data(ensured.folder, () => {
            if (ensured.created.length === 0) {
              ctx.out.line(`${assetsPath(ensured.path)} already exists`);
              return;
            }
            ctx.out.line(
              `Created ${assetsPath(ensured.path)}  ${shortId(ensured.folder?.id ?? '')}`
            );
          });
        })
      )
  );

  program.addCommand(
    inProject(leaf('upload'))
      .description('Upload local files into an Assets folder, one at a time')
      .argument('<paths...>', 'local files to upload')
      .option('--to <folder>', 'destination folder path or id (default: the root)')
      .option(
        '--replace',
        'where a file of that name is already there, add the bytes as its next version'
      )
      .action(
        withCtx(deps, async (ctx, opts, pathsArg) => {
          const paths = pathsArg as unknown as string[];
          const project = await projectFromOpts(ctx, opts);
          const { folder, listing } = await resolveFolderPath(
            ctx,
            project.id,
            optString(opts, 'to') ?? ''
          );
          // Kept current as the batch lands, so two paths sharing a basename
          // meet the first one's file rather than a stale listing.
          const present = new Map(listing.files.map((f) => [f.filename.toLowerCase(), f]));
          await uploadEach(ctx, paths, assetsPath(folderPathOf(listing)), async (path) => {
            const existing = present.get(basename(path).toLowerCase());
            if (existing !== undefined && opts.replace === true) {
              return appendVersion(ctx, existing, path);
            }
            const { body } = await sendFile<FileRow>(
              ctx,
              '/api/files/upload',
              {
                project_id: project.id,
                filename: basename(path),
                folder_id: folder?.id,
                id: crypto.randomUUID(),
              },
              path
            );
            present.set(body.filename.toLowerCase(), body);
            return {
              path,
              outcome: 'uploaded',
              file: body,
              file_id: body.id,
              filename: body.filename,
            };
          });
        })
      )
  );

  program.addCommand(
    inProject(leaf('download'))
      .description('Download a file, or one version of it')
      .argument(...FILE_ARG)
      .option('-o, --output <path>', 'where to write it: a file, a directory, or - for stdout')
      .option('--version <n>', 'a version number from `file versions` (default: the current one)')
      .option('--force', 'overwrite an existing local file')
      .option(...DECK_SCOPE)
      .option(...COMPONENT_SCOPE)
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const requested = optString(opts, 'version');
          const version =
            requested === undefined ? undefined : parsePositiveInt(requested, '--version');
          const file = await resolveFile(ctx, opts, ref);
          const name = localName(
            version === undefined ? file.filename : versionedName(file.filename, version),
            file.id
          );
          const target = await downloadTarget(optString(opts, 'output'), name, opts.force === true);

          const bytes = await fetchFileBytes(ctx, file.id, version, target);
          // Stdout is the file itself here, so nothing else may be written to it.
          if (target === '-') return;
          ctx.out.data(
            { path: target, file_id: file.id, version: version ?? null, byte_size: bytes },
            () => ctx.out.line(`Wrote ${target} (${formatBytes(bytes)})`)
          );
        })
      )
  );

  program.addCommand(fileGroup(deps));
  program.addCommand(folderGroup(deps));
}

function fileGroup(deps: CliDeps): Command {
  const file = group('file', 'Inspect and change one file: rename, move, versions, delete');

  file.addCommand(
    inProject(leaf('show'))
      .description('Show one file: where it lives, its type, size and version')
      .argument(...FILE_ARG)
      .option(...DECK_SCOPE)
      .option(...COMPONENT_SCOPE)
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const row = await resolveFile(ctx, opts, ref);
          const home = await describeHome(ctx, row);
          const { versions } = assertOk(
            await ctx.api.GET('/api/files/{id}/versions', { params: { path: { id: row.id } } })
          );
          ctx.out.data(row, () => {
            ctx.out.line(ctx.out.style('bold', row.filename));
            const lines: [string, string][] = [
              ['id', row.id],
              ['home', home],
              ['type', typeLabel(row)],
              ['size', formatBytes(row.byte_size)],
              [
                'version',
                `${String(versions[0]?.version_number ?? 1)} of ${String(versions.length)}`,
              ],
              ['created', minute(row.created_at)],
              ['updated', minute(row.updated_at)],
            ];
            if (row.deleted_at !== null) lines.push(['deleted', minute(row.deleted_at)]);
            // An import renames a card after its page unless a person named it.
            if (row.name_locked) lines.push(['name', 'set by hand; an import will not rename it']);
            for (const [label, value] of lines) ctx.out.line(`  ${label.padEnd(8)}  ${value}`);
          });
        })
      )
  );

  file.addCommand(
    inProject(leaf('rename'))
      .description('Rename a file; an import will no longer rename it after its page')
      .argument(...FILE_ARG)
      .argument('<name>', 'new filename')
      .option(...DECK_SCOPE)
      .option(...COMPONENT_SCOPE)
      .action(
        withCtx(deps, async (ctx, opts, ref, name) => {
          const row = await resolveFile(ctx, opts, ref);
          const updated = assertOk(
            await ctx.api.PATCH('/api/files/{id}', {
              params: { path: { id: row.id } },
              body: { filename: name },
            })
          );
          ctx.out.data(updated, () =>
            ctx.out.line(`Renamed ${row.filename} to ${updated.filename}`)
          );
        })
      )
  );

  file.addCommand(
    inProject(leaf('move'))
      .description(
        'Move a file to an Assets folder, into a deck, or into a component. Arriving where ' +
          'the name is taken renames it, except between two Assets folders, which refuses'
      )
      .argument(...FILE_ARG)
      .option('--to <folder>', 'an Assets folder path or id; / is the root')
      .option('--to-deck <deck>', 'make it a card of this deck')
      .option('--back', 'with --to-deck: make it the deck’s back rather than a card')
      .option('--to-component <component>', 'give it to this component')
      .option('--role <role>', 'with --to-component: artwork or cut (default artwork)')
      .option(...DECK_SCOPE)
      .option(...COMPONENT_SCOPE)
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const to = optString(opts, 'to');
          const toDeck = optString(opts, 'toDeck');
          const toComponent = optString(opts, 'toComponent');
          const role = optString(opts, 'role');
          const chosen = [to, toDeck, toComponent].filter((v) => v !== undefined);
          if (chosen.length !== 1) {
            throw new CliError('Pass exactly one of --to, --to-deck or --to-component', EXIT.usage);
          }
          if (opts.back === true && toDeck === undefined) {
            throw new CliError('--back applies only with --to-deck', EXIT.usage);
          }
          if (role !== undefined && toComponent === undefined) {
            throw new CliError('--role applies only with --to-component', EXIT.usage);
          }
          if (role !== undefined && role !== 'artwork' && role !== 'cut') {
            throw new CliError(`--role is artwork or cut, not "${role}"`, EXIT.usage);
          }

          const row = await resolveFile(ctx, opts, ref);
          let moved: FileRow;
          let where: string;
          if (to !== undefined) {
            const destination = isRoot(to)
              ? { folder: null, path: '' }
              : await (async () => {
                  const { folder, listing } = await resolveFolderPath(ctx, row.project_id, to);
                  return { folder, path: folderPathOf(listing) };
                })();
            where = assetsPath(destination.path);
            const folderId = destination.folder?.id ?? null;
            // Between two Assets folders the name travels as it is and a clash is
            // refused, which is what the explorer does; leaving a deck or a
            // component is a change of home, which renames on arrival instead.
            moved =
              row.deck_id === null && row.component_id === null
                ? assertOk(
                    await ctx.api.PATCH('/api/files/{id}', {
                      params: { path: { id: row.id } },
                      body: { folder_id: folderId },
                    })
                  )
                : assertOk(
                    await ctx.api.POST('/api/files/{id}/move', {
                      params: { path: { id: row.id } },
                      body: { folder_id: folderId },
                    })
                  );
          } else if (toDeck !== undefined) {
            const deck = await resolveDeck(ctx, row.project_id, toDeck);
            where = opts.back === true ? `deck "${deck.name}" as its back` : `deck "${deck.name}"`;
            moved = assertOk(
              await ctx.api.POST('/api/files/{id}/move', {
                params: { path: { id: row.id } },
                body: { deck_id: deck.id, role: opts.back === true ? 'back' : 'card' },
              })
            );
          } else {
            const component = await resolveComponent(ctx, row.project_id, toComponent as string);
            const asRole = (role ?? 'artwork') as 'artwork' | 'cut';
            where = `component "${component.name}" as its ${asRole}`;
            moved = assertOk(
              await ctx.api.POST('/api/files/{id}/move', {
                params: { path: { id: row.id } },
                body: { component_id: component.id, role: asRole },
              })
            );
          }
          ctx.out.data(moved, () => {
            const renamed =
              moved.filename === row.filename ? '' : `, renamed ${moved.filename} on arrival`;
            ctx.out.line(`Moved ${row.filename} to ${where}${renamed}`);
          });
        })
      )
  );

  file.addCommand(
    inProject(leaf('delete'))
      .description(
        'Delete a file. Soft by default: every version keeps its bytes and `file restore` ' +
          'brings it back. --purge is permanent and the only way to reclaim the storage'
      )
      .argument(...FILE_ARG)
      .option('--purge', 'delete it permanently, with every version')
      .option('--force', 'skip the confirmation --purge asks for')
      .option(...DECK_SCOPE)
      .option(...COMPONENT_SCOPE)
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const row = await resolveFile(ctx, opts, ref);
          const purge = opts.purge === true;
          if (purge) {
            await confirmOrAbort(
              ctx,
              `Permanently delete ${row.filename} and every version of it?`,
              opts.force === true
            );
          }
          assertDone(
            await ctx.api.DELETE('/api/files/{id}', {
              params: { path: { id: row.id }, query: purge ? { purge: 'true' } : {} },
            })
          );
          ctx.out.data({ deleted: row.id, purged: purge }, () =>
            ctx.out.line(
              purge
                ? `Permanently deleted ${row.filename}`
                : `Deleted ${row.filename}; restore it with: threepeaks file restore ${row.id}`
            )
          );
        })
      )
  );

  file.addCommand(
    inProject(leaf('restore'))
      .description('Restore a deleted file to where it was')
      .argument('<entry>', 'a file from `trash list`: its id, name or path')
      .option('--name <filename>', 'restore it under a new name, when the old one has been taken')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const target = await resolveTombstone(ctx, opts, ref, 'file');
          const restored = (await restoreDeleted(ctx, target, optString(opts, 'name'))) as FileRow;
          const home = await describeHome(ctx, restored);
          ctx.out.data(restored, () => ctx.out.line(`Restored ${restored.filename} to ${home}`));
        })
      )
  );

  file.addCommand(
    inProject(leaf('versions'))
      .description('List a file’s versions, newest first')
      .argument(...FILE_ARG)
      .option(...DECK_SCOPE)
      .option(...COMPONENT_SCOPE)
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const row = await resolveFile(ctx, opts, ref);
          const listing = assertOk(
            await ctx.api.GET('/api/files/{id}/versions', { params: { path: { id: row.id } } })
          );
          ctx.out.data(listing, () => {
            ctx.out.table(
              ['VERSION', 'SIZE', 'TYPE', 'CREATED'],
              listing.versions.map((v) => [
                v.is_current ? `${String(v.version_number)} (current)` : String(v.version_number),
                formatBytes(v.byte_size),
                typeLabel(v),
                minute(v.created_at),
              ])
            );
          });
        })
      )
  );

  file.addCommand(
    inProject(leaf('push'))
      .description('Add a local file’s bytes as the next version of a file')
      .argument(...FILE_ARG)
      .argument('<path>', 'the local file holding the new bytes')
      .option(...DECK_SCOPE)
      .option(...COMPONENT_SCOPE)
      .action(
        withCtx(deps, async (ctx, opts, ref, path) => {
          const row = await resolveFile(ctx, opts, ref);
          const { body } = await sendFile<FileVersionResult>(
            ctx,
            `/api/files/${row.id}/versions`,
            {},
            path
          );
          ctx.out.data(body, () => ctx.out.line(describeVersionResult(row.filename, body)));
        })
      )
  );

  file.addCommand(
    inProject(leaf('revert'))
      .description(
        'Make an old version current again. History only grows: the old bytes are copied ' +
          'forward as a new version rather than rewinding the number'
      )
      .argument(...FILE_ARG)
      .argument('<version>', 'the version number to bring back')
      .option(...DECK_SCOPE)
      .option(...COMPONENT_SCOPE)
      .action(
        withCtx(deps, async (ctx, opts, ref, versionArg) => {
          const number = parsePositiveInt(versionArg, 'The version');
          const row = await resolveFile(ctx, opts, ref);
          const result = assertOk(
            await ctx.api.POST('/api/files/{id}/versions/{number}/restore', {
              params: { path: { id: row.id, number: String(number) } },
            })
          );
          ctx.out.data(result, () =>
            ctx.out.line(
              result.created
                ? `Restored version ${String(number)} of ${row.filename} as version ${String(result.version.version_number)}`
                : `Version ${String(number)} is already the current version of ${row.filename}; nothing changed`
            )
          );
        })
      )
  );

  return file;
}

function folderGroup(deps: CliDeps): Command {
  const folder = group('folder', 'Rename, move, delete and restore Assets folders');

  async function resolveFolder(ctx: RuntimeContext, opts: Opts, ref: string): Promise<Folder> {
    if (isRoot(ref)) {
      throw new CliError('The Assets root is not a folder that can be changed', EXIT.usage);
    }
    const project = await projectFromOpts(ctx, opts);
    const { folder: found } = await resolveFolderPath(ctx, project.id, ref);
    return found as Folder;
  }

  folder.addCommand(
    inProject(leaf('rename'))
      .description('Rename a folder')
      .argument('<folder>', 'folder path or id')
      .argument('<name>', 'new name')
      .action(
        withCtx(deps, async (ctx, opts, ref, name) => {
          const found = await resolveFolder(ctx, opts, ref);
          const updated = assertOk(
            await ctx.api.PATCH('/api/files/folders/{id}', {
              params: { path: { id: found.id } },
              body: { name },
            })
          );
          ctx.out.data(updated, () => ctx.out.line(`Renamed ${found.name} to ${updated.name}`));
        })
      )
  );

  folder.addCommand(
    inProject(leaf('move'))
      .description('Move a folder, and everything in it, under another folder')
      .argument('<folder>', 'folder path or id')
      .argument('<parent>', 'the new parent folder path or id; / is the root')
      .action(
        withCtx(deps, async (ctx, opts, ref, parentRef) => {
          const found = await resolveFolder(ctx, opts, ref);
          const parent = isRoot(parentRef)
            ? { folder: null, path: '' }
            : await (async () => {
                const resolved = await resolveFolderPath(ctx, found.project_id, parentRef);
                return { folder: resolved.folder, path: folderPathOf(resolved.listing) };
              })();
          const updated = assertOk(
            await ctx.api.PATCH('/api/files/folders/{id}', {
              params: { path: { id: found.id } },
              body: { parent_id: parent.folder?.id ?? null },
            })
          );
          ctx.out.data(updated, () =>
            ctx.out.line(`Moved ${found.name} into ${assetsPath(parent.path)}`)
          );
        })
      )
  );

  folder.addCommand(
    inProject(leaf('delete'))
      .description(
        'Delete a folder. Soft by default: nothing inside is touched and `folder restore` ' +
          'brings the whole of it back. --purge deletes everything inside, permanently'
      )
      .argument('<folder>', 'folder path or id')
      .option('--purge', 'delete it and its whole subtree permanently')
      .option('--force', 'skip the confirmation --purge asks for')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const found = await resolveFolder(ctx, opts, ref);
          const purge = opts.purge === true;
          if (purge) {
            await confirmOrAbort(
              ctx,
              `Permanently delete ${found.name} and everything inside it, live files included?`,
              opts.force === true
            );
          }
          assertDone(
            await ctx.api.DELETE('/api/files/folders/{id}', {
              params: { path: { id: found.id }, query: purge ? { purge: 'true' } : {} },
            })
          );
          ctx.out.data({ deleted: found.id, purged: purge }, () =>
            ctx.out.line(
              purge
                ? `Permanently deleted ${found.name}`
                : `Deleted ${found.name}; restore it with: threepeaks folder restore ${found.id}`
            )
          );
        })
      )
  );

  folder.addCommand(
    inProject(leaf('restore'))
      .description(
        'Restore a deleted folder with everything in it; what was deleted inside it on its ' +
          'own stays deleted'
      )
      .argument('<entry>', 'a folder from `trash list`: its id, name or path')
      .option('--name <name>', 'restore it under a new name, when the old one has been taken')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const target = await resolveTombstone(ctx, opts, ref, 'folder');
          const restored = (await restoreDeleted(ctx, target, optString(opts, 'name'))) as Folder;
          ctx.out.data(restored, () => ctx.out.line(`Restored folder ${restored.name}`));
        })
      )
  );

  return folder;
}
