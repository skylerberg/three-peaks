import type { Command } from 'commander';
import type { components } from '@three-peaks/shared/api';
import { leaf, withCtx } from '../kit.ts';
import { CliError, EXIT } from '../errors.ts';
import { USER_AGENT } from '../client.ts';
import type { CliDeps, RuntimeContext } from '../context.ts';

type User = components['schemas']['User'];

interface Health {
  status: string;
  name: string;
  environment: string;
  branch: string;
  commit: string;
}

// /health is outside the OpenAPI spec -- it is the load balancer's probe -- so
// it is read by hand. It names the build as well as whether it is up, which is
// what tells a local server on one branch from one on another.
async function readHealth(ctx: RuntimeContext): Promise<Health> {
  let response: Response;
  try {
    response = await ctx.fetch(
      new Request(`${ctx.baseUrl}/health`, { headers: { 'User-Agent': USER_AGENT } })
    );
  } catch (err) {
    throw new CliError(`Cannot reach ${ctx.baseUrl}: ${(err as Error).message}`, EXIT.failure);
  }
  const body = (await response.json().catch(() => null)) as Partial<Health> | null;
  if (body === null || body.name !== 'three-peaks-hub') {
    throw new CliError(
      `${ctx.baseUrl} answered /health with ${String(response.status)} but is not a Three Peaks Hub API`,
      EXIT.failure
    );
  }
  return body as Health;
}

export function registerStatus(program: Command, deps: CliDeps): void {
  program.addCommand(
    leaf('status')
      .description('Show which server this talks to, the build it runs, and who is signed in')
      .action(
        withCtx(deps, async (ctx) => {
          const health = await readHealth(ctx);
          let user: User | null = null;
          if (ctx.token !== null) {
            const result = await ctx.api.GET('/api/auth/me');
            user = result.response.ok ? (result.data ?? null) : null;
          }
          const report = {
            api_url: ctx.baseUrl,
            health,
            user,
            token_source: ctx.token === null ? null : ctx.tokenFromEnv ? 'env' : 'stored',
          };
          ctx.out.data(report, () => {
            ctx.out.line(`Server   ${ctx.baseUrl}`);
            ctx.out.line(
              `Build    ${health.environment}, ${health.branch} @ ${health.commit} (${health.status})`
            );
            if (user !== null) {
              ctx.out.line(`Account  ${user.name} <${user.email}>`);
            } else if (ctx.token !== null) {
              ctx.out.line('Account  the stored token was refused — run: threepeaks login');
            } else {
              ctx.out.line('Account  not signed in — run: threepeaks login');
            }
          });
          if (health.status !== 'ok') {
            throw new CliError(`The server reports ${health.status}`, EXIT.failure);
          }
        })
      )
  );
}
