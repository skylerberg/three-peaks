import { Option, type Command } from 'commander';
import { formatBytes } from '@three-peaks/shared';
import { group, inProject, leaf, optString, withCtx } from '../kit.ts';
import { confirmOrAbort } from '../prompt.ts';
import { day, shortId } from '../output.ts';
import { deletedPath, listDeleted, matchDeleted, projectFromOpts } from '../resolve.ts';
import { describeEntry, purgeDeleted, restoreDeleted } from '../tombstones.ts';
import type { CliDeps } from '../context.ts';

const KINDS = ['file', 'folder', 'deck', 'component'] as const;

export function registerTrash(program: Command, deps: CliDeps): void {
  const trash = group(
    'trash',
    'What has been deleted in a project: list it, restore it, or delete it for good'
  );

  trash.addCommand(
    inProject(leaf('list'))
      .description(
        'List deleted files, folders, decks and components, newest first. Nothing inside a ' +
          'deleted folder is listed on its own: restoring the folder brings it back'
      )
      .addOption(new Option('--kind <kind>', 'only one kind').choices([...KINDS]))
      .action(
        withCtx(deps, async (ctx, opts) => {
          const kind = optString(opts, 'kind');
          const project = await projectFromOpts(ctx, opts);
          const entries = (await listDeleted(ctx, project.id)).filter(
            (entry) => kind === undefined || entry.kind === kind
          );
          ctx.out.data({ entries }, () => {
            if (entries.length === 0) {
              ctx.out.line(`Nothing deleted in ${project.name}`);
              return;
            }
            ctx.out.table(
              ['ID', 'KIND', 'NAME', 'DELETED', 'SIZE', 'BLOCKED BY'],
              entries.map((entry) => [
                shortId(entry.id),
                entry.kind,
                deletedPath(entry),
                day(entry.deleted_at),
                entry.byte_size === null ? '' : formatBytes(entry.byte_size),
                entry.blocked_by ?? '',
              ])
            );
            // The one reason a restore refuses that no name can get past.
            if (entries.some((entry) => entry.blocked_by !== null)) {
              ctx.out.line(
                ctx.out.style(
                  'dim',
                  'A row with BLOCKED BY sits inside something that is itself deleted; restore that first.'
                )
              );
            }
          });
        })
      )
  );

  trash.addCommand(
    inProject(leaf('restore'))
      .description('Put a deleted file, folder, deck or component back where it was')
      .argument('<entry>', 'an entry from `trash list`: its id, name or path')
      .option(
        '--name <name>',
        'restore it under a new name, when the old one has been taken meanwhile'
      )
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const project = await projectFromOpts(ctx, opts);
          const entry = matchDeleted(ref, await listDeleted(ctx, project.id));
          const restored = await restoreDeleted(ctx, entry, optString(opts, 'name'));
          ctx.out.data(restored, () => ctx.out.line(`Restored ${describeEntry(entry)}`));
        })
      )
  );

  trash.addCommand(
    inProject(leaf('purge'))
      .description(
        'Delete an entry permanently and reclaim its storage. A folder takes its whole ' +
          'subtree with it; a deck or a component takes its artwork. This cannot be undone'
      )
      .argument('<entry>', 'an entry from `trash list`: its id, name or path')
      .option('--force', 'skip the confirmation prompt')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const project = await projectFromOpts(ctx, opts);
          const entry = matchDeleted(ref, await listDeleted(ctx, project.id));
          await confirmOrAbort(
            ctx,
            `Permanently delete ${describeEntry(entry)}? This cannot be undone`,
            opts.force === true
          );
          await purgeDeleted(ctx, entry);
          ctx.out.data({ purged: entry.id, kind: entry.kind }, () =>
            ctx.out.line(`Permanently deleted ${describeEntry(entry)}`)
          );
        })
      )
  );

  program.addCommand(trash);
}
