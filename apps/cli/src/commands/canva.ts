import type { Command } from 'commander';
import type { components } from '@three-peaks/shared/api';
import { group, leaf, withCtx } from '../kit.ts';
import { ApiError, CliError, EXIT, assertDone, assertOk } from '../errors.ts';
import { confirmOrAbort } from '../prompt.ts';
import { matchRef } from '../resolve.ts';
import { minute, shortId } from '../output.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

type CanvaLink = components['schemas']['CanvaAppLink'];

async function listLinks(ctx: RuntimeContext): Promise<CanvaLink[]> {
  return assertOk(await ctx.api.GET('/api/canva-app/links')).links;
}

export function registerCanva(program: Command, deps: CliDeps): void {
  const canva = group('canva', 'Link the Canva app to your account and see which build it runs');

  canva.addCommand(
    leaf('pair')
      .description('Link the Canva app to this account with the code it is showing')
      .argument('<code>', 'the pairing code, e.g. ABCD-2345 (case and hyphen do not matter)')
      .action(
        withCtx(deps, async (ctx, _opts, code) => {
          const link = assertOk(await ctx.api.POST('/api/canva-app/pair', { body: { code } }));
          ctx.out.data(link, () =>
            ctx.out.line(
              `Linked the Canva app (${shortId(link.id)}). Reopen it in Canva to carry on.`
            )
          );
        })
      )
  );

  canva.addCommand(
    leaf('links')
      .description('List the Canva accounts linked to this one')
      .action(
        withCtx(deps, async (ctx) => {
          const links = await listLinks(ctx);
          ctx.out.data(links, () => {
            if (links.length === 0) {
              ctx.out.line('No Canva accounts are linked');
              return;
            }
            ctx.out.table(
              ['ID', 'BRAND', 'LINKED', 'LAST USED'],
              links.map((link) => [
                shortId(link.id),
                link.canva_brand_id ?? '',
                minute(link.created_at),
                link.last_used_at === null ? 'never' : minute(link.last_used_at),
              ])
            );
          });
        })
      )
  );

  canva.addCommand(
    leaf('unlink')
      .description('Unlink a Canva account; the app asks for a new code next time')
      .argument('<link>', 'link id or id prefix, as `canva links` prints it')
      .option('--force', 'skip the confirmation prompt')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const link = matchRef(
            ref,
            await listLinks(ctx),
            'Canva link',
            (l) => l.id,
            (l) => l.canva_brand_id ?? ''
          );
          await confirmOrAbort(
            ctx,
            `Unlink Canva link ${shortId(link.id)}? Sessions it was already given stay signed in until revoked.`,
            opts.force === true
          );
          assertDone(
            await ctx.api.DELETE('/api/canva-app/links/{linkId}', {
              params: { path: { linkId: link.id } },
            })
          );
          ctx.out.data({ unlinked: link.id }, () => ctx.out.line(`Unlinked ${shortId(link.id)}`));
        })
      )
  );

  canva.addCommand(
    leaf('build')
      .description('Show which build of the Canva app has most recently run')
      .action(
        withCtx(deps, async (ctx) => {
          let build;
          try {
            build = assertOk(await ctx.api.GET('/api/canva-app/build'));
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              throw new CliError(
                'No Canva app build has reported yet: either the bundle in the Developer Portal ' +
                  'predates build reporting, or nobody has opened the app since it was uploaded.',
                EXIT.notFound
              );
            }
            throw err;
          }
          ctx.out.data(build, () => {
            const rows: [string, string][] = [
              ['Commit', `${build.commit}${build.dirty ? ' (built from a dirty tree)' : ''}`],
              ['Branch', build.branch],
              ['Built', minute(build.built_at)],
              ['First seen', minute(build.first_seen_at)],
              ['Last seen', minute(build.last_seen_at)],
            ];
            for (const [label, value] of rows) {
              ctx.out.line(`${`${label}:`.padEnd(12)}${value}`);
            }
          });
        })
      )
  );

  program.addCommand(canva);
}
