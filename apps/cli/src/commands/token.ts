import type { Command } from 'commander';
import type { components } from '@three-peaks/shared/api';
import { group, leaf, withCtx } from '../kit.ts';
import { assertDone, assertOk } from '../errors.ts';
import { confirmOrAbort } from '../prompt.ts';
import { matchRef } from '../resolve.ts';
import { day, shortId } from '../output.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

type PersonalAccessToken =
  components['schemas']['PersonalAccessTokenList']['personal_access_tokens'][number];

async function listTokens(ctx: RuntimeContext): Promise<PersonalAccessToken[]> {
  return assertOk(await ctx.api.GET('/api/auth/tokens')).personal_access_tokens;
}

export function registerToken(program: Command, deps: CliDeps): void {
  const token = group('token', 'Manage personal access tokens for scripts and agents');

  token.addCommand(
    leaf('list')
      .description('List personal access tokens; secrets are never shown again')
      .action(
        withCtx(deps, async (ctx) => {
          const tokens = await listTokens(ctx);
          ctx.out.data(tokens, () => {
            if (tokens.length === 0) {
              ctx.out.line('No personal access tokens');
              return;
            }
            ctx.out.table(
              ['ID', 'NAME', 'CREATED', 'LAST USED'],
              tokens.map((t) => [
                shortId(t.id),
                t.name,
                day(t.created_at),
                t.last_used_at === null ? 'never' : day(t.last_used_at),
              ])
            );
          });
        })
      )
  );

  token.addCommand(
    leaf('create')
      .description('Create a personal access token and print its secret, once')
      .argument('<name>', 'what the token is for')
      .action(
        withCtx(deps, async (ctx, _opts, name) => {
          const created = assertOk(
            await ctx.api.POST('/api/auth/tokens', { body: { id: crypto.randomUUID(), name } })
          );
          // The secret alone on stdout, so `TOKEN=$(threepeaks token create agent)`
          // captures exactly it; everything said about it goes to stderr.
          ctx.out.data(created, () => {
            ctx.out.error(
              `Created token "${created.personal_access_token.name}" ` +
                `(${shortId(created.personal_access_token.id)}). It does not expire; revoke it when done.`
            );
            ctx.out.line(created.token);
            ctx.out.error('This is the only time the secret is shown; store it now.');
          });
        })
      )
  );

  token.addCommand(
    leaf('revoke')
      .description('Revoke a personal access token')
      .argument('<token>', 'token id, id prefix or name')
      .option('--force', 'skip the confirmation prompt')
      .action(
        withCtx(deps, async (ctx, opts, ref) => {
          const target = matchRef(
            ref,
            await listTokens(ctx),
            'token',
            (t) => t.id,
            (t) => t.name
          );
          await confirmOrAbort(ctx, `Revoke token "${target.name}"?`, opts.force === true);
          assertDone(
            await ctx.api.DELETE('/api/auth/tokens/{id}', { params: { path: { id: target.id } } })
          );
          ctx.out.data({ revoked: true, id: target.id }, () =>
            ctx.out.line(`Revoked token ${target.name}`)
          );
        })
      )
  );

  program.addCommand(token);
}
